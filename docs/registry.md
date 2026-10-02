# Trusted registry: from a hashed file to an app catalogue an institution can verify

Status: stages 1 and 2a are built on `feat/registry-signing`; everything after is a
proposal. Uses the seams that already exist in `signing.rs`, `policy.rs` and `registry.rs`.
The OTP vault in `examples/otp-vault/` is the first tool to go through it.

## Goal

Sanctum runs tools you bring. It should also be able to offer a catalogue of tools that are
useful as standalone apps (an OTP vault is the model: one narrow job, no network, one file)
without weakening what makes Sanctum worth trusting.

## Rules that do not change

These were agreed on 2026-09-30 and every design choice below is checked against them.

1. **A registry signature never grants a capability.** A signature says who published these
   exact bytes and that they were not altered. It does not say the tool is safe and it does
   not approve anything.
2. **Everything local stays as is.** The static scan, the per-tool CSP, origin isolation,
   IPC removal, the integrity check each time a tool opens, quarantine, and per-capability
   approval all run on the bytes on this machine, whatever their source.
3. **"Verified" means publisher identity plus unchanged bytes.** Once revocation exists
   (stage 3) it will also mean not revoked. The UI
   never says "safe", "trusted tool" or "reviewed" on the strength of a signature.
4. **The public registry is free.** Enigma signs only its own tools. Third parties sign
   with their own keys. Enigma takes no cut and sells no tools.
5. **Auto-load is not auto-approve.** A registry may cause tools to be installed. Only the
   user, or a separately delivered and pinned organisation policy, may approve what they
   can do.

Rule 1 is also what keeps a compromised registry bounded: the worst it can do is offer a
file, which is what dragging a file into Sanctum already does.

## What an institution needs to be able to say

| Question | Answer Sanctum should be able to give | Mechanism |
|---|---|---|
| Is this the file that was reviewed? | Same SHA-256 as the reviewed copy. | Content addressing (done) |
| Who published it? | A named publisher key signed this exact statement. | Ed25519 signed statement (stage 1) |
| Where did it come from? | Built from commit X of repository Y by workflow Z. | SLSA provenance attestation (stage 0) |
| Could the publisher have signed a different file for us? | No: every signature is in a public log. | Rekor transparency log (stage 0) |
| Has it been withdrawn? | Checked against a signed, fresh revocation list. | Signed registry index with expiry (stage 3) |
| Can it ask for more than we approved? | No: the signature covers the declared capability list, and the local scan must agree. | Signed `declared` field (stage 1) |
| Can our policy be enforced without users? | Yes: unsigned or unlisted tools do not run. | Org policy file (stage 2) |

## Stage 0: provenance with no Sanctum code change (available now)

`.github/workflows/examples.yml` hashes each example and, on `main`, runs
`actions/attest-build-provenance`. That produces a Sigstore-signed SLSA build provenance
statement for the file's digest, recorded in the public Rekor log, naming the repository,
commit and workflow run. Nobody holds a long-lived signing key; the identity is the
workflow's OIDC token.

```bash
shasum -a 256 index.html
gh attestation verify index.html --repo Enigma-Technologies-Solutions/sanctum
```

Limits: verification is manual and outside Sanctum, and the attestation proves where the
file was built, not that anyone reviewed it.

## Stage 1: signed statements and bundles (`signing.rs`, `crates/sanctum-bundle`)

### What gets signed

A **statement** is a small JSON object the publisher signs. It is not `ToolManifest`:
that struct is derived locally at install time (its `version` is `1.0.<install number>`),
so it cannot carry the publisher's own version.

```jsonc
{
  "schema": 1,
  "app_id": "sh.enigma.otp-vault",   // stable identity, see "App identity" below
  "name": "OTP Vault",
  "version": "1.0.0",                // publisher's version, numeric dotted
  "checksum": "sha256:…",           // the HTML file, byte for byte
  "declared": [ "storage", {"smartcard": ["a0000005272101"]} ],   // DetectedCapability list
  "issued_at": 1790000000            // unix seconds
}
```

**Bytes, not canonical JSON.** The signature covers the exact bytes of the statement as
serialised by the publisher; the envelope carries those bytes (base64url) and the verifier
parses them after checking the signature. This replaces the RFC 8785 canonicalisation
proposed in the first draft of this document: there is no re-serialisation step for the
two sides to disagree about.

**Domain separation.** The signed message is `"sanctum-statement-v1\n" || statement_bytes`.
Publisher certificates (below) use `"sanctum-publisher-cert-v1\n"`. A signature made for
one purpose cannot verify as another, and neither can verify as a Tauri updater signature.

**Keys.** Ed25519. The updater key never signs tools and tool keys never sign updates.

### Bundle file

One file, `*.sanctum`, JSON:

```jsonc
{
  "format": "sanctum-bundle/1",
  "html": "<!doctype html>…",          // exact file contents, UTF-8
  "signature": {
    "payload": "<base64url statement bytes>",
    "sig":     "<base64url>",
    "keyid":   "ed25519:<base64url public key>",
    "chain":   [ /* optional: publisher certificate, see below */ ]
  }
}
```

The HTML is stored as a string, so its SHA-256 (the version id in the library) is the same
as for the loose file. A tool installed from a bundle and the same file dragged in by hand
are the same version.

### Trust anchors and publisher certificates

- **Anchors** are Ed25519 public keys Sanctum trusts to say who a publisher is: one
  Enigma root key compiled into the binary (like the updater's minisign key), plus keys
  pinned by org policy in stage 2.
- A **publisher certificate** is `{subject key, publisher name, not_before, not_after,
  app_id prefixes}` signed by an anchor. The root is used only to sign these and stays
  offline; publisher keys sign statements day to day and can be replaced without touching
  the binary.
- A statement signer is **anchored** if its key is an anchor, or if `chain[0]` is a valid,
  unexpired certificate for that key issued by an anchor and the statement's `app_id`
  falls under a listed prefix.

### Verification outcomes

| Outcome | Meaning | What Sanctum does |
|---|---|---|
| `Verified` | Signature valid, signer anchored, file hash matches | Install, show publisher name |
| `UnknownSigner` | Signature valid, signer not anchored | Install, show key id, no other effect |
| `Invalid` | Bad signature, hash mismatch, malformed | Refuse, nothing written |
| no signature | Plain file | Existing path, unchanged |

`Verified` and `UnknownSigner` unlock nothing the plain file did not have. Both go through
the same scan and the same approval screen.

### Install checks (after the signature passes)

1. **Declared vs detected.** The local scan must find nothing the statement did not declare
   (per capability; for `net` and `smartcard` the detected hosts or AIDs must be a subset
   of the declared ones, and `(dynamic)` must itself be declared). Declared but not
   detected is allowed, because the scan is advisory and a publisher may over-declare. An
   undeclared capability means the bundle is refused: either the publisher's declaration
   is wrong or the file is not what they signed.
2. **App identity.** `app_id` maps to one library tool. A bundle with a known `app_id`
   becomes a new version of that tool, so **the tool id, and with it the origin and its
   storage, stays the same**. A vault keeps its data across updates.
3. **No downgrade.** The bundle's version must be greater than the highest version
   installed for that `app_id`. The same version with the same hash is a no-op; the same
   version with a different hash is refused. Rolling back to an older local version stays
   available through the existing rollback command, which is a user action.
4. **Approvals are unchanged.** Stored approvals are an explicit list, and the tool window
   CSP is built only from that list. A new version cannot gain a capability because nothing
   grants it; the user sees new capabilities on the approval screen as they do today.

### Storage

Provenance lives beside the version, not inside `ToolManifest`:

- `tools.app_id` (nullable): the stable identity, unique when set.
- `bundle_provenance(version_id PK, app_id, publisher_key, publisher_name, trust,
  statement, signature, issued_at, installed_at)`.

### Tooling

`crates/sanctum-bundle` is a small library with no Tauri dependency, used by both the app
(verify) and a CLI (`keygen`, `cert`, `sign`, `inspect`, `verify`). One implementation,
two callers. Private keys are created and kept by the person holding them; nothing in this
repository generates a production key. Hardware-held keys (a YubiKey's OpenPGP applet,
which supports Ed25519, or a cloud HSM) are the next step and do not change the format.

## Stage 2: organisation policy (`policy.rs`)

**Stage 2a is built:** `pinned_checksums` only, read from an admin-owned file, enforced in
`open_tool_window` against the freshly verified hash, failing closed on a broken file. See
[policy.md](policy.md). The rest of this section is stage 2b.

A read-only policy file deployed by MDM (macOS configuration profile, Windows registry or
GPO, `/etc/sanctum/policy.json` on Linux), signed by the organisation's policy key, which
is pinned by the same MDM channel. Sanctum never fetches policy from a registry. The stub's
structure stands. Two additions institutions will ask for:

- `pinned_checksums`: an allow-list of exact SHA-256 values. The strongest control, and it
  works before any signing exists: IT reviews the OTP vault once and pins its hash.
- `grants`: capabilities pre-approved per publisher or `app_id`, for example Enigma's OTP
  vault may be granted `storage` and `smartcard:a0000005272101` and nothing else. A grant
  is a **ceiling intersected with what the tool declares and the scan detects**, so a
  later version that asks for more gets nothing extra.

Enforcement lives in `open_tool_window`, next to the integrity check, so a policy violation
refuses the window the same way a checksum mismatch does.

## Stage 3: the registry (`registry.rs`)

A static, signed index, not a service. It can be served from GitHub Pages or any object
store, and mirrored inside a customer network.

```jsonc
// registry/index.json, signed as a whole (detached index.json.sig)
{
  "schema": 1,
  "version": 42,                 // strictly increasing: rollback protection
  "expires": "2026-10-26T00:00:00Z", // stale index = warning: freeze protection
  "tools": [{
    "app_id": "sh.enigma.otp-vault",
    "checksum": "sha256:…",
    "name": "OTP Vault",
    "version": "1.0.0",
    "bundle_url": "https://…/otp-vault-1.0.0.sanctum",
    "publisher": "ed25519:…",
    "attestation": "https://…/attestations/…",
    "published_at": "2026-09-26T00:00:00Z",
    "revoked": false,
    "revoked_reason": null
  }]
}
```

The client runs in Rust on a timer, never in a tool window:

1. Fetch index and signature; verify against the registry's key; refuse a `version` lower
   than the last one seen; warn when past `expires`.
2. Listing a tool makes it *installable*. Install downloads the bundle and runs the full
   stage 1 checks. The index is a pointer, not an authority: the bundle's own signature and
   the local scan still decide.
3. A revoked checksum is quarantined exactly like a tampered file.

The fetch sends no account or device identifiers and no telemetry. The server still sees
the requester's IP address. Like the update check, it is a
network call the privacy copy must name.

For key rotation, threshold signing (two of three YubiKeys for the root) and separate
roles, adopt TUF with the `tough` crate instead of a single-signature index. The index
above maps onto TUF's targets metadata.

## Connecting to a registry, and private registries (paid tier)

A **registry connection** is a descriptor: `{name, url, anchor keys, policy hint}`. There
are two ways one gets on a machine, and they differ in what they may do:

| | Added by the user | Delivered by org policy |
|---|---|---|
| Appears in the catalogue | Yes | Yes |
| Tools install | On click | Automatically (a `required` list, plus updates) |
| Capabilities | User approves each, as today | Only what the signed policy `grants`, else user approves |
| Can be removed by the user | Yes | Only if the policy allows |

So a company's private registry can put its tools on every laptop without a click, and
still cannot hand any of them a capability the policy did not name. The descriptor and the
policy arrive out of band (MDM), which is the company's root of trust. A registry cannot
introduce another registry or widen its own grants.

Free tier: public and self-hosted static registries, added by hand. Paid tier: the control
plane around it, below.

### Identity and user management (enterprise, later)

Identity is what turns a static catalogue into something an enterprise buys:

- **Sign-in to the registry** with the company IdP (OIDC with PKCE in the system browser;
  SAML through the registry's broker). The token is held in the OS keychain and used by
  Rust only. Tool windows never see it.
- **Entitlements by group.** The registry returns different tool sets per IdP group claim.
- **Deprovisioning.** SCIM removes a user; the registry stops serving them and publishes
  revocations; clients quarantine on the next sync.
- **Audit.** Installs, updates, approvals and launches recorded with the signed-in
  identity and sent to the company's own sink.

This needs a server (hosted by Enigma or by the customer), which is why it is the paid
product. Identity is data for the registry and audit log; it is not passed to tools unless
a future, explicit capability does so.

## Publishing the OTP vault through this path

1. Merge `examples/otp-vault/`: the Examples workflow attests `index.html` (stage 0).
2. The maintainer generates the Enigma root and publisher keys on their own machine with
   the CLI, signs a publisher certificate with the root, and builds `otp-vault-1.0.0.sanctum`.
3. Users and IT install the bundle and see *Verified, Enigma Technologies Solutions*
   (stage 1).
   The signed bundles are hosted on the project site: `node scripts/publish-bundles.mjs`
   copies the newest verified bundle of each example into `web/apps/` and regenerates
   `web/apps/index.html` (served at `https://sanctum.enigma.sh/apps/`). It refuses any
   bundle that is not anchored to the compiled-in Enigma root. A user downloads the
   file and opens it in Sanctum; there is no in-app browsing yet.
4. Later: add it to `registry/index.json` (stage 3); a customer's policy pins its hash or
   grants the Enigma publisher `storage` and the OATH applet (stage 2).

## Order of work

| Stage | Sanctum change | Value | Status |
|---|---|---|---|
| 0 | Workflow only | Verifiable build provenance | Done on the examples branch |
| 1 | Bundle format, verify, install with provenance, CLI | Publisher identity inside the app | In progress |
| 2a | `pinned_checksums` only | Hash allow-listing without key management | Built, see policy.md |
| 3 | Signed index client, revocation, store UI | Catalogue and fleet-wide status | Proposal |
| 2b | Full policy file, private registries | Central enforcement | Proposal |
| IdP | Registry server with OIDC, SCIM, audit | The enterprise product | Proposal |

## Known gaps this design does not close

- `script-src 'unsafe-inline'` is required for single-file tools, so script injection
  inside a tool is unmitigated by design. First-party catalogue tools should be audited,
  and a signature is not an audit.
- The scan is regex-based and advisory. The CSP is the control; declared-vs-detected only
  catches honest mistakes and obvious misstatements.
- Storage follows the tool id: deleting a tool and adding it again gives an empty origin.
  A vault needs its export path before it is offered as an app.
