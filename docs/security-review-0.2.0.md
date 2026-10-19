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
| Dependencies | `Cargo.lock`, `pnpm-lock.yaml` | `cargo audit` and `pnpm audit --prod` run on 2026-10-18. See "Dependency audit" |

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

## Dependency audit (2026-10-18)

`cargo audit` (653 crates, advisory database of that day) and `pnpm audit --prod`.

Fixed:
- `rustls` 0.23.43 to 0.23.46 (and `rustls-webpki` to 0.103.15). Four advisories, all in the TLS
  stack the registry fetcher uses: RUSTSEC-2026-0285, 0346, 0348, 0349. Lockfile only.
- Eight `pnpm` advisories (postcss, nanoid, braces, source-map-js, postcss-selector-parser)
  all came through `tailwindcss-animate`, a Tailwind build plugin that was listed as a runtime
  dependency. It is now a dev dependency. None of it ships in the app, which contains only the
  CSS Tailwind produced. `pnpm audit --prod` is clean.

Left, with the reason:
- `zip` 4.6.1 (RUSTSEC-2026-0367, 0368, 0369), pulled in only by `tauri-plugin-updater`. The
  flaws are in extracting a malicious archive. Sanctum extracts only an update archive after its
  minisign signature has been checked, so abusing it needs our update signing key. Not
  reachable by a server, a mirror or a registry. Fix when the updater plugin moves to `zip` 9.
- `quick-xml` 0.39.4 (RUSTSEC-2026-0194, 0195), pulled in by `plist` inside `tauri`. It reads
  plist files of the app itself and the system, never data from a registry or a tool. Fix when
  `tauri` updates it.
- `rsa` 0.9.10 (RUSTSEC-2023-0071). It is in `Cargo.lock` through the `sqlx` MySQL driver, which
  Sanctum does not use. `cargo tree` shows no path to it, so it is not compiled.
- 13 warnings: unmaintained crates (`unic-*`, `proc-macro-error`, `zbus`/`zvariant` on Linux)
  and three unsound ones (`anyhow`, `event-listener`, `glib`), all indirect through `tauri`. No
  fix we can apply. Recheck on each Tauri update.

## Still owed

1. Hands-on checks in `docs/registry-ui-checklist.md`, on Windows and Linux in particular.
2. Prove the updater across a version: install 0.1.0, upgrade to 0.2.0.
