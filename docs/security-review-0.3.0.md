# Security review for 0.3.0

Scope: everything added since 0.2.0 that touches the network, untrusted text, another process or
the operating system. Most of it is building apps with Codex (`src-tauri/src/agent/`), plus file
saving to Downloads, registry notices and the smart card changes. Reviewed by reading the code and
its tests, by running Codex 0.163.0 under Sanctum's sandbox and trying to get out of it
(`live_layer_2`), and by watching the system log for every sandbox refusal during real use. This is
a self-review by the author, not an outside audit. An outside review is still wanted before any
paid tier.

## The threat model for building apps

Codex is OpenAI's agent, downloaded from OpenAI's GitHub releases and checked against a hash built
into Sanctum. It is trusted to be Codex. What it does is not trusted: the model can be steered by
anything it reads, including the app it is asked to change, so every command it runs is treated as
hostile. Two sandboxes stand between those commands and the computer:

- **Layer 1, Codex's own policy**, which Sanctum sets for every turn: writes only in the work folder,
  no network for commands, no approvals asked of the person.
- **Layer 2, Sanctum's own Seatbelt profile around the whole Codex process** (`agent/outer.rs`), on
  every macOS build. Reads only from system folders, the Codex program, Codex's own folder and the
  work folders. Writes only to Codex's folder and the work folders. Network only to a proxy inside
  Sanctum, which allows `CONNECT` to `chatgpt.com:443` and `auth.openai.com:443` and only from the
  Codex process itself. System services only from a fixed list of seven.

Building apps is offered on macOS only (`install::OFFERED_ON`), because Layer 2 exists only there.
Linux and Windows show that it is not available yet.

## What was reviewed

| Area | Files | Result |
|---|---|---|
| Codex download and install | `agent/install.rs`, `codex-pins.json` | No findings. Archive and program hashes pinned; only the named entry is unpacked, size capped, to a fixed path; GitHub hosts only; checked again before every start |
| Talking to Codex | `agent/rpc.rs`, `protocol.rs`, `process.rs` | No findings. Every request from Codex is refused (`-32601`); lines over 8 MB end the connection; only listed variables reach the process |
| Sign-in | `agent/account.rs`, `protocol.rs` | One finding (F1), fixed |
| Turn policy | `agent/chat.rs` | No findings. Policy, writable root and network flag are asserted in tests; proxy variables are kept out of commands |
| Reading drafts | `agent/chat.rs` (`read_draft`), `draft.rs`, `history.rs` | No findings. Links, folders and files swapped during the read are refused; size capped. Hard links are refused by the sandbox (checked live) |
| Draft preview windows | `commands/runner.rs` (`open_draft_window`) | No findings. Same lockdown as a tool window: no approvals, strict CSP, no IPC, navigation and new windows blocked; the copy is deleted on close |
| Sanctum's sandbox | `agent/outer.rs` | Two findings (F2, F3), fixed before it was turned on |
| File saving | `commands/downloads.rs` | One finding (F4), fixed |
| Text from Codex on screen | `src/lib/agent.ts`, `commands.ts` | No findings. Replies, activity labels, draft names and errors pass `cleanText`; replies are parsed Markdown with links shown as text |
| Window permissions | `capabilities/create.json`, `main.json` | No findings. The Create window gets only the chat commands; Delete agent data is main window only; tool and draft windows get nothing |
| Registry notices | `registry/notices.rs` | No findings. Uses the 0.2.0 fetcher and checks; the daily check is off by default |
| Dependencies | `Cargo.lock`, `pnpm-lock.yaml` | `cargo audit` and `pnpm audit --prod` run on 2026-11-18. See "Dependency audit" |

## Findings

**F1. The sign-in address could be any https host (low, fixed).**
Codex builds the address Sanctum opens in the browser for sign-in. Sanctum checked for https, a
real host and no embedded credentials, but not which host. A Codex steered by a setting a command
planted could have opened a lookalike sign-in page in the person's own browser. Fix: the address
must be `https://auth.openai.com` on the default port (`protocol::AUTH_HOST`), the only sign-in host
the proxy lets Codex reach anyway. Tests cover other hosts, lookalike suffixes, ports, plain http
and embedded user names.

**F2. Every system service was reachable from inside Sanctum's sandbox (high, fixed before release).**
The first version of the profile allowed every `mach-lookup`. Through Launch Services and Apple
events a command could run `open` or `osascript` and start a program outside the sandbox, such as a
browser with a URL carrying data, and `pbpaste` could read the clipboard. It was found while
measuring the list, before the profile was turned on in any build. Fix: a fixed list of seven
services, measured by logging every lookup during the live test and a real session
(`MACH_SERVICES`). `SecurityServer` is on the list because Codex fails every request without it;
the keychains stay closed (inside the profile, `security dump-keychain` lists nothing). The live
test checks that `open` of an app and of a URL, `osascript`, the clipboard and the keychain fail.

**F3. A command could plant files that act in later sessions (low, fixed).**
Commands may write to Codex's own folder, because Codex keeps its state there. Codex reads
`config.toml`, `AGENTS.md`, `.env` and hooks (which run commands on events) from it at start.
Anything they did would still run inside the sandbox, but it would outlast the conversation that
planted it. `config.toml` and `AGENTS.md` were already write-protected. Fix: `.env`, `hooks.json`
and `hooks/` are write-protected too, and the live test checks it.

**F4. A few macOS files that act when opened could be saved (low, fixed).**
The list of refused extensions covered programs and scripts but not configuration profiles
(`.mobileconfig`), Shortcuts (`.shortcut`), Finder location files (`.fileloc`) or plug-in bundles
that arrive as one file name. Each still needs the person to open it and approve it. Fix: added
to the list, with tests.

## Notes on things that look risky and are not

- **Commands can read Codex's own folder, including the sign-in token.** They have no network to
  send it anywhere. The only way out is the model conversation, which already runs on that account.
- **`file-read-metadata` is allowed everywhere.** A command can learn that a file exists and its
  size and dates, not its contents. Many tools look up parent folders, so it stays.
- **Codex itself reaches the network.** Only through the proxy, only to the two hosts, and the
  proxy checks that the connecting socket belongs to the Codex process (libproc), so a command that
  learns the proxy's port is refused. A secret in the proxy address would not help: a command can
  read Codex's environment through a `sysctl` no Seatbelt rule blocks.
- **Codex's own sandbox does not run under Layer 2.** Seatbelt cannot nest, so turns use
  `externalSandbox` and commands run under Sanctum's profile alone. It is the stricter of the two.
- **Delete agent data signs out first.** If the computer is offline it gives up after 15 seconds and
  deletes the files anyway, so the token may stay valid at OpenAI until it expires. The person can
  revoke it in their ChatGPT settings.

## Accepted for 0.3.0

- **Seatbelt is deprecated by Apple.** It is still what Codex and other agents use on macOS. Track it.
- **No company proxy.** Sanctum's proxy connects directly. On a network that only allows traffic
  through a company proxy, building apps cannot reach OpenAI. Chaining comes later.
- **Linux and Windows.** Building apps is not offered there until Sanctum's own sandbox exists
  (bubblewrap on Linux; a decision is still owed for Windows).
- **The model sees what Codex reads.** Everything in the work folder, including an app being
  changed, goes to OpenAI. Settings and the Create window say so.

## Dependency audit (2026-11-18)

`cargo audit` (655 crates, advisory database of that day) and `pnpm audit --prod` (clean).

Fixed:
- `rustls-webpki` 0.103.15 to 0.103.17 (RUSTSEC-2026-0382) and `webpki-root-certs` 1.0.9 to 1.0.12
  (RUSTSEC-2026-0383). Both are about distrusted intermediate certificates, in the TLS stack the
  registry fetcher and the Codex download use. Lockfile only.

Left, with the reason:
- `libsqlite3-sys` 0.30.1 (RUSTSEC-2026-0459). The flaw needs a crafted database and log file pair
  in Sanctum's own data folder; anyone who can write there already controls Sanctum's data. The fix
  needs `sqlx` 0.9, a larger change than a release should carry. Planned after 0.3.0.
- `zip` 4.6.1 (RUSTSEC-2026-0367, 0368, 0369 as at 0.2.0, and now 0429, 0545, 0548), pulled in only
  by `tauri-plugin-updater`. Sanctum extracts only an update archive after its minisign signature
  has been checked, so abusing any of them needs our update signing key. Fix when the updater moves
  to `zip` 9.
- `quick-xml` 0.39.4 (RUSTSEC-2026-0194, 0195) and `rsa` 0.9.10 (RUSTSEC-2023-0071): unchanged from
  0.2.0, for the same reasons (plist files of the app and system only; the MySQL driver is not
  compiled).
- Unmaintained and unsound warnings, all indirect through `tauri` and `sqlx`, now including
  `chrono` (unmaintained). No fix we can apply. Recheck on each Tauri update.

## Still owed before tagging

1. The manual checklist in [create-app-plan.md](create-app-plan.md) with a release build on macOS:
   sign in, sign out, Delete agent data, kill Codex during a turn, offline, a prompt asking Codex to
   read `~/.ssh` and to call `curl`.
2. On Linux and Windows, that Settings and the Create card say building apps is not available, and
   that nothing downloads.
3. VoiceOver on the Create window and the new Settings rows (owed since 0.2.0 for the rest).
