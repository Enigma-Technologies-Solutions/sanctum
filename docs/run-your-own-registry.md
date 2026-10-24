# Run your own registry

A registry is a set of static files on an HTTPS address: a catalogue, a list of withdrawn versions, and one signed bundle for each tool. Anyone can publish one. A team can keep its approved tools in one, a vendor can publish its own, and you can host one for yourself. Sanctum reads it, checks every file, and shows the tools in the Catalogue.

This guide takes you from nothing to a registry that Sanctum can add and install from. The format itself is specified in [registry-format.md](https://github.com/Enigma-Technologies-Solutions/sanctum/blob/main/docs/registry-format.md). Nothing here needs a server that runs code.

## What to expect

Sanctum trusts two things out of the box: the Enigma root key that is compiled into the app, and keys the person using it pins by hand. Your registry is signed by your own key, so the first time someone adds it, Sanctum says it does not recognise the signer, shows the key, and asks. They check it against the key you published, and only then is the registry added.

Three rules hold for every registry, including yours:

- A signature says who published a file and that it has not changed. It never says the tool is safe.
- A signature never grants a capability. A tool from your registry installs with no approvals, and the person approves each one on the usual screen.
- A tool signed by a key Sanctum does not know installs as an unknown signer, even from a registry the person pinned. Pinning your registry vouches for the catalogue, not for the publisher key on each tool.

## What you need

- A checkout of the [Sanctum repository](https://github.com/Enigma-Technologies-Solutions/sanctum). The scripts below live in it.
- A recent Node, and a Rust toolchain. The signing command line tool is built from source with `cargo`.
- A place to host static files over HTTPS. GitHub Pages, an object store, or a folder on an internal web server all work.

Define a shortcut for the signing tool, run from the root of the checkout:

```bash
sb() { cargo run -q --manifest-path src-tauri/crates/sanctum-bundle/Cargo.toml -- "$@"; }
```

## 1. Choose names

- The registry id starts with `registry:` followed by a reverse domain name you control, for example `registry:com.example.tools`. It is the registry's identity. It stays the same if you move to another host.
- Each tool has an app id that is a reverse domain name too, for example `com.example.hello`. App ids never contain a colon.

## 2. Make two keys

```bash
sb keygen --out publisher.key
sb keygen --out registry.key
```

Each command writes a secret key file that only you can read, refuses to overwrite an existing file, and prints the public key id, which looks like `ed25519:` followed by a string of letters. Write both ids down. Back the files up somewhere offline, because a lost key cannot be recovered.

The two keys do different jobs on purpose. The publisher key signs tools. The registry key signs the catalogue and the list of withdrawn versions, and you will use it again every few weeks to renew them, so it is the one that may later live on a build server. Keep the publisher key offline. A leaked registry key cannot sign a tool, and a leaked publisher key cannot sign a registry.

## 3. Sign each tool

For each single-file HTML tool, run the signing script. It scans the file the same way Sanctum does, so the bundle declares exactly what the app will detect at install:

```bash
scripts/sign-tool.sh hello.html com.example.hello "Hello" 1.0.0 publisher.key
```

It writes `com.example.hello-1.0.0.sanctum` next to the HTML file and prints what it declared, for example `[]` for a tool that asks for nothing, or `["storage"]`. Put the finished bundles in one folder, say `bundles/`.

A version only goes up. To ship a change, sign it as `1.0.1` or higher.

## 4. Write the registry sources

Make a folder, for example `registry-src/`:

```
registry-src/
  registry.json
  revocations.json
  apps/
    com.example.hello/
      app.json
      CHANGELOG.md
      manual.md
```

`registry.json` names the registry and sets how long each signed file stays valid:

```json
{
  "id": "registry:com.example.tools",
  "name": "Example Tools",
  "kind": "public",
  "site_url": "https://tools.example.com",
  "index_days": 90,
  "revocations_days": 14
}
```

`revocations.json` starts empty:

```json
{ "entries": [] }
```

`apps/com.example.hello/app.json` describes one tool. The summary is at most 200 characters and the description at most 2000. Screenshots are optional, up to eight PNG or WebP images in a `screenshots/` folder next to it, each with a `file` name and an `alt` text:

```json
{
  "app_id": "com.example.hello",
  "summary": "Says hello.",
  "description": "A tiny example tool.",
  "license": "MIT",
  "screenshots": []
}
```

`CHANGELOG.md` has one heading per version, newest first, and one line per change. The line starts with `added`, `changed`, `fixed`, `security` or `removed`:

```
## 1.0.0 (2026-10-24)
- added: First release.
```

`manual.md` is optional. It uses a small subset of Markdown: headings, paragraphs, bold, italic, code, one level of lists, quotes, and links that start with `https://`. Raw HTML, images, tables and nested lists are errors, so that every viewer shows exactly what you wrote.

## 5. Build

The builder reads your sources and bundles, checks each bundle, and writes the registry files. It never signs anything. It needs to be told that your publisher key is trusted for this build, with `--anchor`, and it needs a sitemap file with two marker comments, because it also writes an optional set of web pages. You can discard those pages.

Create `sitemap.xml` once:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <!-- registry:begin -->
  <!-- registry:end -->
</urlset>
```

Then build, using your publisher key id in the anchor:

```bash
node scripts/build-registry.mjs \
  --source registry-src \
  --bundles bundles \
  --out site/registry/v1 \
  --site scratch/apps \
  --sitemap sitemap.xml \
  --anchor "ed25519:YOUR_PUBLISHER_KEY_ID=Example Tools"
```

It prints which files changed and need signing. Keep the `site/registry/v1` folder between runs. The builder reads the old index from it to raise the serial number, and a client refuses an index whose serial goes down.

## 6. Sign the catalogue

Sign the two files the builder wrote, with the registry key:

```bash
sb registry-sign --kind index --key registry.key \
  --file site/registry/v1/index.json --out site/registry/v1/index.json.sig
sb registry-sign --kind revocations --key registry.key \
  --file site/registry/v1/revocations.json --out site/registry/v1/revocations.json.sig
```

Both print a note that there is no certificate, so clients will treat the key as an unknown signer. That is expected for a registry that is not signed under the Enigma root. People pin your key when they add the registry.

## 7. Check it the way a client would

```bash
node scripts/verify-registry.mjs site/registry/v1 \
  --id registry:com.example.tools \
  --anchor "ed25519:YOUR_PUBLISHER_KEY_ID=Example Tools" \
  --anchor "ed25519:YOUR_REGISTRY_KEY_ID=Example Tools registry"
```

It should end with `OK.` and a count of apps. If it says `id_mismatch`, you left out `--id`, which defaults to Enigma's registry.

## 8. Host it

Upload everything under `site/registry/v1` to your host so that `index.json` is at an address you control, such as `https://tools.example.com/registry/v1/index.json`. The address of the folder is the registry address. Serve the files as they are. Every file other than the index is checked against a hash in the signed index, so a proxy that rewrites a file makes it fail, and a mirror or a CDN needs no trust.

The address must use `https`, with no user name, query or fragment. It may point at a private network.

## 9. Add it in Sanctum

Open the Catalogue, choose Add a registry, and paste the address of the folder, for example `https://tools.example.com/registry/v1/`. Sanctum fetches the index, sees a signer it does not recognise, and shows the signing key. Compare it with your registry key id, which you should publish somewhere people can check, such as your own website. When it matches, tick the box and choose Add and trust this key.

From then on the tools appear in the Catalogue. Installing one runs the same checks as a file you add by hand, and the tool starts with no approvals.

## 10. Keep it fresh

Two files expire. The catalogue lasts 90 days by default and the list of withdrawn versions lasts 14. Renew them before they lapse. An expired file shows a warning in Sanctum and does not block browsing or installing, but a client can no longer rely on the list being current.

```bash
node scripts/build-registry.mjs --renew \
  --source registry-src --bundles bundles --out site/registry/v1 \
  --site scratch/apps --sitemap sitemap.xml \
  --anchor "ed25519:YOUR_PUBLISHER_KEY_ID=Example Tools"
```

Then sign both files again as in step 6 and upload them. A calendar reminder every ten days is enough.

To publish a new version of a tool, sign the new bundle, add a section to its `CHANGELOG.md`, copy the bundle into `bundles/`, then build, sign, verify and upload.

To withdraw a version, add an entry to `revocations.json` with the checksum of that tool's HTML, its app id, a reason (`compromised`, `vulnerable`, `withdrawn` or `mistake`) and the time it was revoked, then build, sign and upload. A client matches on the checksum, so the file is withdrawn wherever it came from.

## If something goes wrong

- **The builder refuses a bundle.** Its signature must verify and chain to an anchor you passed with `--anchor`. Check that the key id in the flag is the publisher key that signed the bundle.
- **A changelog error.** The headings must read `## X.Y.Z (YYYY-MM-DD)` and each change must start with one of the five types followed by a colon.
- **Sanctum says the signer is not recognised.** That is the normal first step for your own registry. It shows the key so that you can pin it.
- **Sanctum refuses an update to the registry.** The serial went down or stayed the same with different contents. Rebuild from the same `site/registry/v1` folder you published last.
- **A tool refuses to install.** The scan found a capability the bundle did not declare. Sign it again with `scripts/sign-tool.sh`, which declares what the scan finds.

## What this does not do

It does not deliver tools to people's machines without a click, and it does not give a tool any access. Those belong to an organisation policy, which is separate and described in [registry.md](https://github.com/Enigma-Technologies-Solutions/sanctum/blob/main/docs/registry.md). A registry also does not raise a publisher's standing: only a certificate issued under a root that Sanctum knows can do that.
