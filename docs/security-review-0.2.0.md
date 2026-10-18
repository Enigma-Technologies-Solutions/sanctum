# Security review for 0.2.0

Scope: everything added since 0.1.0 that touches the network, untrusted text, or the
operating system. Reviewed by reading the code and its tests, and by mutation testing the fixes.
This is a self-review by the author, not an outside audit. An outside review is still wanted
before any paid tier.

## What was reviewed

| Area | Files | Result |
|---|---|---|
| Registry fetcher | `src-tauri/src/registry/fetch.rs` | No findings. See notes |
| Verification and install | `registry/client.rs`, `install.rs` | No findings. Install reuses the bundle checks; the signed statement must match the index; approvals start empty |
| Detail page and images | `registry/detail.rs` | No findings. Every file is hash and size checked; images reach the window as `data:` URLs |
| Link handling | `registry/link.rs`, `deeplink.rs`, `LinkInstallDialog.tsx` | One finding (F1), fixed |
| Markdown manuals | `src/lib/markdown.ts`, `Markdown.tsx` | No findings. Parsed to data, rendered as React elements, links are copy only |
| Registry text on screen | `src/lib/text.ts` and its callers | One finding (F2), fixed |
| New Tauri plugins | `tauri-plugin-deep-link`, `tauri-plugin-single-instance` | No findings. No capability file grants `deep-link:*`; tool windows still have no permissions |
| Install redirect page | `workers/install/index.mjs` | No findings. Static, strict CSP, no script, no redirect |
| Dependencies | `Cargo.lock`, `pnpm-lock.yaml` | Not done. See "Still owed" |

## Findings

**F1. A page could swap the install dialog under the user's click (low, fixed).**
Opening `sanctum://` links in a loop replaces the dialog each time, so a click meant for one
tool could land on another. Each link also needs the browser's own "open Sanctum" prompt, which
limits this, but the app should not rely on it. Fix: the buttons that move a link forward stay
disabled for 700 ms after a dialog appears (`armDelayMs`). Nothing is ever installed without a
click, and an installed tool still has no approvals. A test fails if the delay is removed.

**F2. Registry text could contain characters that hide or reorder text (low, fixed).**
The schema limits the length of names, summaries, descriptions and the manual, but not which
characters they contain. A registry the user pinned could use right-to-left overrides or
zero-width characters to make a name look like another. Enigma's own registry is not affected.
Fix: `cleanText` removes direction controls, zero-width and control characters (line feeds and
tabs stay) at the one place registry data enters the interface (`Commands`). Tests cover each
character range. The signed format is unchanged, so no signature or vector changed.

## Notes on things that look risky and are not

- **The registry address can be any https host, including one on a private network.** That is
  intended: an organisation will host a registry inside its network. The fetcher sends only
  GET requests, follows only same origin redirects, caps size and time, and everything it
  receives must pass signature and hash checks before it is used.
- **Redirects.** Each hop must keep scheme, host and port. A registry cannot send Sanctum to
  another host.
- **No decompression.** `reqwest` is built without gzip, brotli or deflate, so a download
  cannot expand past its size cap.
- **SVG screenshots.** The scan for active content is a deny list, so it is only a second line.
  The first is that an SVG is shown through an `img` element, where scripts never run.
- **Links in manuals.** They cannot navigate. They show their address and a Copy button.

## Accepted for 0.2.0

- Names and descriptions from a registry the user pinned are shown as that registry signed
  them, minus hidden characters. A confusing but visible name (a lookalike letter) is not
  detected. The key and publisher name are always shown next to it.
- Windows and Linux link delivery and single instance behaviour are untested on real machines.
  Only the macOS installed bundle has been exercised.

## Still owed

1. Dependency audit. `cargo audit` and `pnpm audit` have not been run for 0.2.0, and about 480
   lines were added to `Cargo.lock`. Run `cargo install cargo-audit --locked` once, then
   `cd src-tauri && cargo audit` and `pnpm audit --prod`.
2. Hands-on checks in `docs/registry-ui-checklist.md`, on Windows and Linux in particular.
3. Prove the updater across a version: install 0.1.0, upgrade to 0.2.0.
