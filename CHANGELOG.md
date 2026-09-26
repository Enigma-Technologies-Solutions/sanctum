<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Enigma Technologies Solutions
-->

# Changelog

Notable changes to Sanctum. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [semantic versioning](https://semver.org/spec/v2.0.0.html).

`release.yml` links every GitHub Release body here, so each tag should leave a
section behind.

## [Unreleased]

## [0.1.0] - 2026-09-21

First release. macOS builds are signed with a Developer ID certificate
(`Enigma Technologies Solutions Limited`, team `477TM7R48U`), notarized by Apple
and stapled, so they open with only the standard downloaded-from-the-Internet
prompt. Windows installers are not yet code-signed; SmartScreen will ask for
*More info → Run anyway*. Linux packages are unsigned, as is usual for
`.deb`/`.AppImage`. Every update payload on every platform is minisign-signed
and verified before install.

### Added: smart card access for tools

Sanctum can hand an approved tool a raw APDU channel to **one** smart card
applet, over the platform PC/SC stack (WinSCard, pcsc-lite or macOS PCSC, all
shipped with the OS). This is the first working implementation of the
`device_broker.rs` seam.

The motivating case is CTAP2 `hmac-secret`: a FIDO2 card will compute
`HMAC-SHA256(CredRandom, salt)` inside the chip, where `CredRandom` never
leaves it. WebAuthn doesn't expose that to web pages, so a browser-based tool can't
use it.

- `smartcard.rs`: the broker, with reader enumeration, sessions, AID allow-list,
  APDU policy, ISO 7816 response chaining.
- `window.sanctum.smartcard` in approved tool windows:
  `listReaders`, `open`, `select`, `transmit`, `close`.
- `DetectedCapability::Smartcard` with per-applet approval; the static scan
  lifts literal AIDs out of tool source so the prompt can name the applet
  ("FIDO2 / WebAuthn (CTAP)") instead of asking for blanket card access.
- Rust tests: 55 → 95.

**No Tauri IPC was re-enabled for tool windows.** The bridge is same-origin
`fetch` to `sanctum-tool://tool-{id}/__sanctum/v1/…`, answered by the custom
protocol handler, where the caller's identity is the webview label supplied by
the runtime rather than anything the page can set. Re-enabling IPC would have
handed tools a general-purpose `invoke` and made the whole surface depend on
the ACL never regressing.

Enforcement, all in Rust:

| Guard | Effect |
|-------|--------|
| Capability check | No approval → no readers, no sessions, no APDUs |
| AID allow-list | `select` refused unless that exact AID was approved |
| No re-selection | Raw `transmit` refuses interindustry `SELECT` / `MANAGE CHANNEL` / `GET RESPONSE`, so a tool approved for FIDO cannot pivot to PIV or OpenPGP on the same card |
| Select-before-transmit | Raw APDUs refused until an approved applet is selected |
| Session ownership | Sessions bound to the opening tool, dropped when its window closes |

CSP change is one directive: approved tools get `connect-src 'self'
sanctum-tool:`, their own origin, served entirely by Sanctum, with no path off
the machine. The scheme is named explicitly because WebKitGTK does not reliably
match a custom-scheme document against `'self'`.

### Fixed

- **Reader enumeration no longer resets cards.** Dropping a `pcsc::Card`
  disconnects with `Disposition::ResetCard`; listing readers was therefore
  power-cycling every card it looked at, which on a contactless card means
  deactivating it until the user re-presents it. Every disconnect is now an
  explicit `LeaveCard`.
- **Card presence is read with `SCardGetStatusChange`,** not by connect-probing.
  Connecting succeeds against cards the driver has already lost and cannot
  distinguish present-and-working from present-but-`MUTE`.
- **A card reset mid-session recovers in place.** Sanctum reconnects, re-selects the
  applet and retries once. Only a physically absent card surfaces to the tool
  (HTTP 409).
- **WebKitGTK renders correctly on Raspberry Pi.** The DMABUF renderer paints
  torn horizontal bands on the Pi's V3D driver; `WEBKIT_DISABLE_DMABUF_RENDERER`
  is now set on Linux before GTK initialises, unless the environment already
  sets it.

### Changed: bundle identifier

- **Bundle identifier is now `sh.enigma.sanctum`** (was `app.sanctum.dev`, a
  domain ETS never owned). Changed before the first signed release on purpose:
  the identifier is baked into the code-signing identity and the app-data path
  (`~/Library/Application Support/sh.enigma.sanctum/` on macOS), so changing it
  after release would strand every user's `sanctum.db`. Development installs
  keep their data at the old path; move the directory across to carry it over.

### Changed: build and CI

- **CI builds no longer attempt to sign.** With an updater public key in
  `tauri.conf.json` and no private key in the environment, `tauri build`
  refuses to run, which had been failing every platform. CI now builds with
  `createUpdaterArtifacts` off; signing stays in `release.yml`.
- **macOS CI is one universal leg, not two per-arch legs.** GitHub retired the
  `macos-13` Intel image, so the x86_64 job was never assigned a runner. It
  queued for 24 hours until the run was cancelled, holding the matrix red while
  every other leg passed. Intel coverage now comes from cross-compiling on the
  M-series runner, matching what `release.yml` already ships. The unsigned
  `.dmg` is uploaded as an artifact.
- **`release.yml` no longer fails macOS when no signing certificate exists.**
  The bundler codesigns on the *presence* of `APPLE_CERTIFICATE`; passing the
  secret through unconditionally set it to the empty string and every macOS
  build died importing an empty `.p12`. The Apple variables are now exported
  only when the certificate secret is non-empty, so the leg builds unsigned
  until the Developer ID certificate is enrolled.
- **Linux arm64 is in both matrices,** on `ubuntu-22.04-arm`. It is
  22.04 on purpose, whose glibc (2.35) predates Raspberry Pi OS Bookworm's (2.36), so the
  `.deb` installs there. A 24.04 build does not.
- Linux jobs upload their `.deb` and `.AppImage` as workflow artifacts.
- `scripts/pi-setup.sh` and `scripts/pi-build.sh` build on a Pi directly.
- The build step runs under `bash` on every platform; PowerShell strips the
  quotes out of inline JSON arguments.
- The `.deb` declares `pcscd`, `libpcsclite1` and `libccid`.

### Security

- Updater signing key rotated to minisign ID `59F59E13694FB434`. The previous
  key's public half had been left in `tauri.conf.json` after rotation, a
  pairing that signs successfully and is then rejected by every client. Verify
  `~/.tauri/*.key.pub` against the config `pubkey` after any rotation; the
  failure is silent by construction.

### Verified on hardware

A Cryptknox FIDO2 card, driven from an HTML tool inside Sanctum on a Raspberry
Pi 400 (Alcor Link AK9567, contact slot):

- applet select, `getInfo` (`FIDO_2_1`, `hmac-secret`, no PIN set),
  `makeCredential`, `clientPIN(getKeyAgreement)`, `getAssertion` with the
  `hmac-secret` extension, all returning `9000`;
- the derived secret is **stable** across repeated derivations with the same
  passphrase, **different** for a different passphrase, and **survives an
  application restart**, because the bytes come from the card, not from anything the
  page retained.

Contactless readers brown the card out during key generation and leave it mute
until re-presented; a contact reader does not.

[Unreleased]: https://github.com/Enigma-Technologies-Solutions/sanctum/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Enigma-Technologies-Solutions/sanctum/releases/tag/v0.1.0
