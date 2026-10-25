# Build your own branded Sanctum

Sanctum has no setting for a white-label build. There is no configuration file that swaps the name, the colours and the registry. A branded version is a fork of the source, built with your own name, your own keys and your own update address. This guide lists every place in the code that carries Enigma's identity, in the order you will want to change them, and says plainly what is a small edit and what is not provided.

Nothing below weakens the security model, and none of it should. A branded build still starts every tool with no access, still checks every hash, and still never lets a signature grant a capability.

## Before you start

- **The licence.** Sanctum is AGPL-3.0-only. If you give a modified build to other people, you must give them the source of your changes under the same licence, and keep the copyright and licence notices in the files. Your own code can sit alongside it. Read the licence, or ask your lawyer, before you plan a closed build, because this one cannot be closed.
- **The names.** The AGPL does not give you rights to Enigma's names, logos or the ETS mark. There is no written trademark policy yet, so ask before you use the Sanctum name for your build, and give your product a name of its own.
- **Building from source.** Follow Building from source in the [README](https://github.com/Enigma-Technologies-Solutions/sanctum#building-from-source) first and get an unmodified build running. Then change one thing at a time.
- **Finding what you missed.** From the root of the checkout, `grep -rni "enigma" src src-tauri/src src-tauri/tauri.conf.json` and `grep -rn "Sanctum" src src-tauri/src` list the places that still carry the old identity.

## 1. Name and identity

These are in `src-tauri/tauri.conf.json`:

- `productName` is the name of the app and its installer.
- `identifier` is the reverse domain name that the operating system uses to tell apps apart. It also decides where the app keeps its library, so a build with a different identifier does not see the library of another Sanctum install. Choose it once and keep it.
- The window `title` is the name in the title bar.
- `plugins.deep-link.desktop.schemes` is the link scheme, `sanctum` by default. The code that reads those links checks the same word, as `SCHEME` in `src-tauri/src/registry/link.rs`, so change both and run the tests.

Some window titles that tell people a tool is untrusted also say "Sanctum". Those are in `src-tauri/src/commands/runner.rs`. Keep the warning, change the name.

## 2. Look and feel

- **Colours.** The tokens are in `src/index.css`: the light theme under `:root`, the dark theme under `:root[data-theme="dark"]`. The accent is `--volt`. Change the tokens, not the components, and every screen follows.
- **Mark and icons.** The monogram in the header is `src/components/StMark.tsx`, drawn from `assets/logo/st-monogram.svg`. The app icons are in `src-tauri/icons`. Tauri can make the whole set from one square image with `pnpm tauri icon your-icon.png`.
- **One theme only.** The Appearance section in Settings lets people choose light, dark or the system setting, and the choice is kept in the window's local storage. To ship a single theme, make `readTheme` in `src/lib/theme.ts` always return the one you want, remove the Appearance section from `src/components/settings/SettingsView.tsx`, and update `src/lib/theme.test.ts` and `src/components/settings/Appearance.test.tsx`, which expect the system default.

## 3. Who you trust

A branded build should recognise your publisher, not Enigma's. The keys it trusts out of the box are compiled in, in `COMPILED_ANCHORS` in `src-tauri/src/trust.rs`. Replace Enigma's root key id and name with yours, then update the tests in that file that name the Enigma root.

The root is a key you make with `keygen` and keep offline. It is used only to certify other keys:

- A publisher certificate names your publisher key and the app ids it may sign, for example `com.example.`. Tools signed under it show as signed by your publisher.
- A registry certificate has a scope that starts with `registry:`, for example `registry:com.example.`. A registry signed under it is recognised at once, so nobody sees the "unknown signer" question when they add it.

The commands for both are in [Run your own registry](https://sanctum.enigma.sh/docs/run-your-own-registry/), and `sanctum-bundle cert` prints its usage when run with no arguments. The helper scripts `scripts/sign-example.sh` and `scripts/sign-registry.sh` check for Enigma's root and your key will not match, so use the commands directly or copy the scripts and change the expected key.

## 4. A registry that is already there

The Welcome panel has a Browse signed tools button. It adds the Enigma registry in one click and opens the Catalogue. The address is a constant in two places, `ENIGMA_REGISTRY_URL` in `src/lib/registry.ts` and in `src-tauri/src/registry/link.rs`. Point both at your registry address and rename them, and the tests that compare them tell you if they drift.

With your root compiled in and your registry signed under a registry certificate, that click is the whole setup. Sanctum does not add a registry by itself at first launch, and that is deliberate: the one thing it does on its own is check for updates. If your product needs a registry that is already present, call `Commands.addRegistry` from your own first-run code. That edit is small, but it is yours to make and test, and it is not part of the tool today.

Delivering a registry to a machine from an organisation policy file is designed but not built. The pinned-checksum policy that exists today is described in [policy.md](https://github.com/Enigma-Technologies-Solutions/sanctum/blob/main/docs/policy.md).

The `sanctum://install` links and the install redirect page in `workers/install` are Enigma's. Run your own copy of the worker or leave links out.

## 5. Updates and releases

- **Update address and key.** `plugins.updater.endpoints` and `plugins.updater.pubkey` in `tauri.conf.json` decide where updates come from and which key they must be signed with. Make your own pair with `pnpm tauri signer generate`, put the public key in the file, and keep the private key in your release secrets, never in the repository.
- **Signing identities.** macOS needs your own Apple Developer identity for signing and notarising, and Windows needs your own code signing certificate. The release workflow in `.github/workflows/release.yml` is written for Enigma's accounts and secrets. Read it end to end before you reuse it.

## 6. What to leave alone

- **Build apps with Codex** is off by default and sends a person's messages to OpenAI when they turn it on. Whether another product may offer it depends on OpenAI's terms, which are not settled even for Enigma. Leave it off in a branded build until you have your own answer.
- **The security model.** The origin separation, the content policy, the hash checks and the rule that approvals start empty are what the product is. A change that loosens any of them is a different product, and it should not carry this design's claims.

## Before you ship

- Run `cargo test` in `src-tauri` and `pnpm test` at the root. Fix the tests that name Enigma on purpose.
- Add a tool to your registry, install it from a clean library, and check that the publisher you expect is shown and that the approval screen starts empty.
- Run the grep commands above again and read what is left.
