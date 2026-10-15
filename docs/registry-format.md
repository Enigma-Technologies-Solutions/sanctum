# Registry format v1

Status: **draft for review** (Phase 1 of [registry-plan.md](registry-plan.md)). Nothing here
is implemented in the app yet. The executable form of this document is
[`spec/registry/`](../spec/registry): JSON Schemas, a reference verifier in Node, and signed
test vectors. The Rust client must give the same verdict as the reference on every vector.

Background and the rules this must respect are in [registry.md](registry.md). This file
replaces the stage 3 sketch there.

## What a registry is

A set of static files under one base URL. No server logic is needed to publish or read one.
GitHub Pages works, and so does any object store, a mirror, or a folder on a customer's
network.

```
<base>/index.json                   the catalogue
<base>/index.json.sig               detached signature over the exact bytes of index.json
<base>/revocations.json             withdrawn tool versions
<base>/revocations.json.sig
<base>/apps/<app_id>.json           per-app detail: description, changelog, manual and screenshot refs
<base>/apps/<app_id>/...            manual (.md) and screenshots (.png, .webp), icon
<base>/bundles/<app_id>-<version>.sanctum
```

Everything the client downloads is checked. The index is verified by signature. Every other
file is verified by the SHA-256 and size recorded in the index. A mirror, a CDN or a proxy
can therefore serve any of it without being trusted.

## Rules that do not change

1. A registry signature never grants a capability. It says who published a catalogue and
   that it was not altered. Installing from a registry runs the same bundle verification, the
   same local scan and the same approval screen as a file dragged in by hand.
2. "Installed from a registry" and "Verified publisher" are statements about identity and
   unchanged bytes. The UI never turns them into "safe", "trusted tool" or "reviewed".
3. Install and "install all" approve nothing.

## Signing

### Detached signatures over exact bytes

`index.json.sig` is JSON:

```jsonc
{
  "format": "sanctum-registry-sig/1",
  "keyid": "ed25519:<base64url public key>",
  "sig": "<base64url, 64 bytes>",
  "chain": [ /* zero or one publisher certificate, same shape as in bundles */ ]
}
```

The signature covers `domain || file bytes`, exactly as served. There is no canonical JSON
and no re-serialisation: a verifier checks the signature on the bytes it downloaded and only
then parses them. The builder writes JSON deterministically (two-space indent, keys in a
fixed order, trailing newline) so rebuilding gives identical bytes, but that is a build
convention, not a verification rule.

| File | Domain prefix |
|---|---|
| `index.json` | `sanctum-registry-index-v1\n` |
| `revocations.json` | `sanctum-registry-revocations-v1\n` |
| publisher certificate (shared with bundles) | `sanctum-publisher-cert-v1\n` |
| tool statement (bundles) | `sanctum-statement-v1\n` |

No prefix is a prefix of another, so a signature made for one purpose never verifies as
another. None can verify as a Tauri updater signature.

### Who may sign a registry

The signer is **anchored** if its key is a trust anchor, or if `chain[0]` is a certificate
issued by an anchor that is valid now, names the signer as `subject`, and has a `scope`
entry that is a prefix of the registry `id`. This is the bundle rule with the registry id in
place of the app id.

Registry ids start with `registry:` (for example `registry:sh.enigma.public`). App ids never
contain a colon. A publisher certificate scoped to apps (`sh.enigma.`) therefore cannot sign
a registry, and a registry certificate (`registry:sh.enigma.`) cannot sign a tool. This is
tested.

An unanchored signature is not an error. It means "unknown signer": the client may still
offer the registry if the user pinned its key when adding it, and every bundle still goes
through its own verification.

## `index.json`

```jsonc
{
  "format": "sanctum-registry/1",
  "id": "registry:sh.enigma.public",   // identity, independent of where it is hosted
  "name": "Enigma Technologies Solutions",
  "kind": "public",                    // "public" | "licensed" (reserved, see below)
  "serial": 7,                         // strictly increases: rollback protection
  "issued_at": 1790000000,             // unix seconds
  "expires": 1797776000,               // freshness limit
  "mirrors": ["https://enigmahq.sh/registry/v1/"],   // optional, https, end with "/"
  "revocations": "revocations.json",   // optional path
  "apps": [{
    "app_id": "sh.enigma.shamir",
    "name": "Shamir Secret Sharing",
    "summary": "Split a secret into shares.",          // at most 200 characters
    "publisher": { "keyid": "ed25519:…", "name": "Enigma Technologies Solutions" },
    "access": "free",                  // "free" | "licensed" (reserved)
    "latest": "1.0.2",
    "icon":   { "path": "apps/sh.enigma.shamir/icon.png", "sha256": "sha256:…", "size": 1234 },  // optional
    "detail": { "path": "apps/sh.enigma.shamir.json", "sha256": "sha256:…", "size": 2345 },
    "versions": [{
      "version": "1.0.2",
      "published_at": 1790000000,
      "bundle":   { "path": "bundles/sh.enigma.shamir-1.0.2.sanctum", "sha256": "sha256:…", "size": 56789 },
      "checksum": "sha256:…",          // the tool's HTML; equals the signed statement's checksum
      "declared": ["storage"],         // equals the signed statement's declared list
      "attestations": []               // optional, reserved
    }]
  }]
}
```

Notes:

- `id` is the registry's identity. Hosts can change (Pages, Cloudflare, a customer mirror).
  The id and the signing key do not.
- `publisher` and `declared` are display data so the catalogue can show who and what scope
  before anything is downloaded. They are not authoritative. See "Installing".
- Every path is **relative**, with no query string, no `..`, no leading dot in any segment,
  and no absolute URL. A client resolves it against the base URL it fetched the index from,
  or against a listed mirror. This is what stops an index from pointing a client at another
  host.
- Unknown properties are allowed and ignored. They are covered by the signature because the
  signature covers the whole file.

### Reserved for later (v2: paid registry)

- `kind: "licensed"` and `access: "licensed"` mean the entry is **listed but not
  installable** by a v1 client. The catalogue data (description, scope, changelog) can stay
  public while the download is gated. A v1 client must show such an entry without an Install
  button. The licence mechanism is not part of this format version.
- `attestations[]` carries third-party or Enigma review signatures. A v1 client parses it
  and **ignores it**: it never shows "Reviewed" on the strength of this field. Verification
  rules come with the paid registry and will not change anything already signed.

## `apps/<app_id>.json`

```jsonc
{
  "format": "sanctum-registry-app/1",
  "app_id": "sh.enigma.shamir",
  "description": "Plain text, at most 2000 characters.",
  "homepage": "https://…",             // optional, https
  "source": "https://…",               // optional, https
  "license": "AGPL-3.0-only",          // optional
  "changelog": [{
    "version": "1.0.2",
    "date": "2026-09-30",
    "changes": [{ "type": "added", "text": "…" }]   // added | changed | fixed | security | removed
  }],
  "manual": { "path": "apps/sh.enigma.shamir/manual.md", "sha256": "sha256:…", "size": 4321 },  // optional
  "screenshots": [{
    "path": "apps/sh.enigma.shamir/shot-1.png", "sha256": "sha256:…", "size": 123456,
    "width": 1280, "height": 800, "alt": "Splitting a secret into five shares"
  }]
}
```

It has no signature of its own. The index pins its SHA-256 and size, so it is exactly as
trustworthy as the index. Its `app_id` must equal the index entry's.

Content limits: description 2000 characters, 100 changelog entries, 8 screenshots (PNG or
WebP, at most 2 MiB each, 8192 pixels on a side), manual at most 64 KiB. The icon may be
PNG, WebP or SVG and is only ever shown through an image element, never inlined.

The manual is Markdown restricted to headings, paragraphs, emphasis, code, lists, block
quotes and links with `https:` targets. Raw HTML and images are not allowed in it. The
renderer is specified in Phase 6; it must treat the text as untrusted.

### Manual Markdown

A manual is Markdown restricted to a small subset, checked when the registry is built so
that what is published is exactly what every renderer shows:

- headings `#` to `####`, paragraphs, block quotes
- `**strong**`, `*emphasis*` and `` `code` ``
- fenced code blocks
- bullet and numbered lists, one level only
- links written `[text](https://...)`; no other scheme, no relative links

Raw HTML, images, tables and nested lists are errors, not silently dropped. Line endings are
LF. A renderer must escape all text and treat the file as untrusted even though the build
already checked it.

## `revocations.json`

```jsonc
{
  "format": "sanctum-registry-revocations/1",
  "registry": "registry:sh.enigma.public",   // must equal the index id
  "serial": 3,
  "issued_at": 1790000000,
  "expires": 1791209600,
  "entries": [{
    "checksum": "sha256:…",             // the tool's HTML hash, which is also its version id
    "app_id": "sh.enigma.otp-vault",
    "version": "1.0.0",                 // optional, informational
    "reason": "vulnerable",             // compromised | vulnerable | withdrawn | mistake
    "note": "optional, at most 200 characters",
    "revoked_at": 1790000000
  }]
}
```

It is signed separately so it can be re-issued often and served from a fast path (for
example Cloudflare) without touching the index. Revocations match on the tool's content
hash, so a revoked file is revoked wherever it came from. What a client does with a revoked
version (block or warn) is client policy, decided in Phase 8.

The index stores no `revoked` flag. There is one source of truth for withdrawal.

## How Enigma builds and signs its registry

Sources live in the repository, outputs are committed, and the site publishes them from
`main`:

| Path | What |
|---|---|
| `registry/registry.json` | Registry id, name, validity periods |
| `registry/apps/<app_id>/` | `app.json`, `CHANGELOG.md`, `manual.md`, `screenshots/` |
| `registry/revocations.json` | Revoked tool hashes |
| `web/registry/v1/` | The published registry (this format) |
| `web/apps/` | The human pages, generated from the same data |

```bash
node scripts/build-registry.mjs            # build; says which files need signing
scripts/sign-registry.sh                   # sign what changed (you run this, with your keys)
node scripts/verify-registry.mjs           # verify as a client would, plus consistency checks
node scripts/build-registry.mjs --check    # CI: committed files match the sources
```

The builder refuses to publish a bundle unless its signature verifies, its file hash
matches, and its certificate chains to a trust anchor. It never signs. When it changes
`index.json` or `revocations.json` it raises the `serial`, restarts the validity period and
deletes the old `.sig`, so a stale signature can never sit beside a new file.

The registry is signed by its own key, not the publisher key that signs tools. The root
certifies it once with the scope `registry:sh.enigma.`, so a leaked registry key cannot
sign a tool and a leaked publisher key cannot sign a registry. Revocations must be re-issued
every 14 days, so this key is the one that may later live on a server while the root and the
publisher key stay offline.

## Verifying (what a client must do, in order)

For `index.json`:

1. Reject files over the size limit (index 2 MiB, revocations 256 KiB, signature file 16 KiB).
2. Parse `index.json.sig` and check it against `sigfile.schema.json`. Else `sig_malformed`.
3. Verify the signature over `domain || bytes`. Else `bad_signature`. **Nothing is parsed
   before this passes.**
4. Parse the JSON as UTF-8. Else `malformed_json`.
5. If `format` is a string other than `sanctum-registry/1`, `format_unsupported`.
6. Validate against the schema and the rules below. Else `schema_invalid`.
7. `id` must equal the id the user added. Else `id_mismatch`.
8. `issued_at` more than 24 hours ahead of the local clock: `from_future`.
9. Against the newest accepted index for this registry: a lower `serial` is `rollback`;
   an equal `serial` with different bytes is `serial_replay`; equal serial with the same
   bytes is fine.
10. Work out trust (anchored or not) as described under "Who may sign a registry".
11. If now is past `expires`, the index is **stale**. Stale is a state, not an error.

Only after all of this does a client replace its cached copy. A failed refresh leaves the
previous good copy in place.

`revocations.json` follows the same steps, with `registry` in place of `id`.

### Rules beyond the schema

- `expires` is after `issued_at`.
- `app_id` values are unique. Versions within an app are unique.
- `latest` names a listed version.
- `bundle.path` is exactly `bundles/<app_id>-<version>.sanctum`.
- `detail.path` is exactly `apps/<app_id>.json`.
- Revocation `checksum` values are unique.

### Installing (Phase 5 will enforce this)

1. Fetch the bundle, check size and SHA-256 against the index. Else `size_mismatch` or
   `hash_mismatch`.
2. Run the existing bundle verification (signature, anchor, checksum, declared vs scan).
3. The bundle's signed statement is the authority. Its `app_id`, `version`, `checksum` and
   `declared` must equal the index entry's. Any difference refuses the install and flags the
   registry as inconsistent.
4. Check the checksum against the revocation list.
5. Ingest through the existing path (downgrade rule, app identity, scan, approval).

## Freshness and signing cadence

`expires` exists so an attacker cannot freeze a client on an old index and hide a
revocation. Since the signing key stays offline, someone has to re-sign before it lapses.
Proposed defaults: index valid for 90 days, revocations for 14. A stale file warns; it does
not block browsing or installing, because bytes and signatures are still checked. Whether
install should be blocked when revocations are stale is an open decision.

## Limits

| Item | Limit |
|---|---|
| `index.json` | 2 MiB, 500 apps, 200 versions per app |
| `revocations.json` | 256 KiB, 5000 entries |
| App detail | 256 KiB |
| Bundle | 32 MiB (same as direct install) |
| Screenshot | 2 MiB, 8 per app |
| Manual or report | 64 KiB |
| Icon | 256 KiB |
| Mirrors | 4 |

## Test vectors

`spec/registry/vectors/vectors.json` lists every case: the files, the clock (`now`), the
anchors, the expected registry id, the previously seen serial, and the verdict. Verdicts are
`ok` with trust and staleness, or an error code. Codes: `too_large`, `sig_malformed`,
`bad_signature`, `malformed_json`, `format_unsupported`, `schema_invalid`, `id_mismatch`,
`from_future`, `rollback`, `serial_replay`, `size_mismatch`, `hash_mismatch`.

All keys in the vectors are test keys derived from public strings. A test fails if any of
them appears in `src-tauri/src/trust.rs`.

```bash
node spec/registry/make-vectors.mjs          # regenerate (deterministic)
node --test spec/registry/test/*.test.mjs    # reference verifier against every vector
```

## Open decisions for review

1. Registry ids use a `registry:` prefix to keep them out of the app id namespace. The
   alternative is a new certificate domain; this reuses existing certificate code.
2. Index 90 days and revocations 14 days validity, warn only when stale.
3. Revoked policy: block first-party, warn third-party (Phase 8).
4. `licensed` entries are listed but not installable in v1.
5. The icon may be SVG, shown only as an image.
