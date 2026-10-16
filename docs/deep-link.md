<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Enigma Technologies Solutions
-->

# Install links

`sanctum://install?app=<app_id>` opens Sanctum on the page for one tool. It is an
invitation, not an instruction: **every link ends in a confirmation, and nothing is installed,
added or approved without a click inside Sanctum.**

## Format

```
sanctum://install?app=<app_id>[&registry=<base url>]
```

| Part | Rule |
| --- | --- |
| action | `install` only. Any other word is refused. |
| `app` | Required. A registry app id: `[a-z0-9]+(\.[a-z0-9-]+)+`, at most 100 characters. |
| `registry` | Optional. A registry base address: `https://`, ending in `/`, at most 300 characters, the same shape the registry format allows. Left out means the Enigma public registry. |
| anything else | Refused: other keys, repeated keys, a user name, password, port, path or `#` part, control characters, a link over 2048 characters. |

Whether a registry is Enigma's is decided by comparing the parsed address with the one built
into Sanctum (`ENIGMA_REGISTRY_URL`), never by looking for a name inside the text. A refusal
message is fixed text. Nothing from the link is echoed back, so a hostile link cannot put its
own words on screen.

The parser is `src-tauri/src/registry/link.rs`. It does no I/O.

## What Sanctum does with a link

1. **Receive.** Rust receives the link (`src-tauri/src/deeplink.rs`): from the operating system
   on macOS, or from the command line on Windows and Linux, where the single-instance plugin
   hands a second launch's arguments to the running Sanctum. Only the first `sanctum:` argument
   is used. The main window is brought to the front. No webview can read or register links:
   no capability grants `deep-link:*`.
2. **Look locally.** The window opens a confirmation. It reads only what is already on the
   computer: the added registries and their verified, cached catalogues. **No request is
   made.**
3. **Ask.**
   - Registry already added and the app is listed: show the app, who published it and what it
     asks for. A click on *Install* installs it.
   - Enigma registry not added: ask to add it. A click downloads and verifies its signed list.
     The app is shown next, and a second click installs.
   - Another registry not added: show its full address and open the normal *Add a registry*
     dialog, which shows the signing key and asks the user to trust it. Same two clicks after.
   - App not in the cached catalogue: offer to check the registry again (one request, on click).
   - Withdrawn, licensed or already installed apps show their state and offer no install.
4. **Install.** The same path as the Catalogue: the signed statement must equal the catalogue
   entry, and the tool starts with **no approvals**. The user approves each permission later on
   the usual screen.

Only the app id and the registry address come from the link, and both are validated first.
Names, summaries and permissions come from the signed catalogue.

## Why a link cannot do harm on its own

- Parsing makes no request and changes nothing.
- The dialog has no path from "arrived" to "installed" that does not pass a button.
- A link cannot name a version, an approval, a key to trust, or a file to open.
- A signature never grants a capability, and a link is not a signature: installing from a link
  gives exactly the access a Catalogue install gives, which is none.
- Another program, a web page or a tool running in Sanctum can open a link. All that does is
  show the dialog, which a person can cancel. Opening links repeatedly only replaces the
  pending request, so dialogs do not stack.

## The https version

`workers/install/` is a small Cloudflare Worker for `https://enigmahq.sh/install/<app_id>`.
Email programs, chat apps and Markdown viewers often block custom schemes, but they open web
links. The worker answers with a static page holding an *Open in Sanctum* button, a link to the
tool's page, and a link to download Sanctum. It does not open Sanctum by itself, keeps no state,
calls nothing, and writes only a validated app id into the page. It always uses the Enigma
registry: a `registry` value in the address is ignored.

Deploy (needs your Cloudflare login, so run it yourself):

```
cd workers/install && npx wrangler deploy
```

Tests: `node --test workers/install/`.

## The website

Each tool page under `sanctum.enigma.sh/apps/<app_id>/` has an *Install in Sanctum* button that
links to `sanctum://install?app=<app_id>` directly, beside the file download. Pages are made by
`scripts/build-registry.mjs`.

## Registering the scheme

- **macOS:** the bundle's `Info.plist` declares `sanctum`, from `plugins.deep-link` in
  `src-tauri/tauri.conf.json`. Works in an installed build, not in `pnpm tauri dev`.
- **Windows:** the installer registers it.
- **Linux:** the `.deb` and the AppImage desktop entry carry it. Development builds register it
  at start (debug builds only; release builds never write that registration themselves).

Click-through on all three systems, from a browser, an email and a Markdown file, is in
`docs/registry-ui-checklist.md`.
