# Trusted registry: from a hashed file to an enterprise-verifiable tool

Status: proposal. Uses the seams that already exist in `signing.rs` (v1), `policy.rs`
(v2) and `registry.rs` (v3). The OTP vault in `examples/otp-vault/` is the first tool to
go through it.

## What an institution needs to be able to say

| Question | Answer Sanctum should be able to give | Mechanism |
|---|---|---|
| Is this the file that was reviewed? | Same SHA-256 as the reviewed copy. | Content addressing (done) |
| Who published it? | A named publisher key signed this exact manifest. | Ed25519 manifest signature (stage 1) |
| Where did it come from? | Built from commit X of repository Y by workflow Z. | SLSA provenance attestation (stage 0) |
| Could the publisher have signed a different file for us? | No: every signature is in a public log. | Rekor transparency log (stage 0) |
| Has it been withdrawn? | Checked against a signed, fresh revocation list. | Signed registry index with expiry (stage 3) |
| Can it ask for more than we approved? | No: the signature covers the capability list. | Signed `detected` field (stage 1) |
| Can our policy be enforced without users? | Yes: unsigned or unlisted tools do not run. | Org policy file (stage 2) |

Sanctum already gives the first row: a version is stored under its SHA-256, the hash is
recomputed on every launch, and a mismatch quarantines the tool. The rest is below.

## Stage 0: provenance with no Sanctum code change (available now)

`.github/workflows/examples.yml` hashes each example and, on `main`, runs
`actions/attest-build-provenance`. That produces a Sigstore-signed SLSA build provenance
statement for the file's digest, recorded in the public Rekor log, naming the repository,
commit and workflow run. Nobody holds a long-lived signing key; the identity is the
workflow's OIDC token.

An institution verifies a copy before importing it:

```bash
shasum -a 256 index.html
gh attestation verify index.html --repo Enigma-Technologies-Solutions/sanctum
```

and compares the digest with **Inspect → SHA-256** after adding it to Sanctum.

Limits: verification is manual and outside Sanctum, and the attestation proves where the
file was built, not that anyone reviewed it.

## Stage 1: signed manifests (`signing.rs`)

`ToolManifest.signature` exists and is always `null`. Fill it:

1. **Canonical bytes.** Serialize the manifest with sorted keys, no whitespace, UTF-8
   (RFC 8785 JSON canonicalization), with `signature` removed. The signed payload is
   `"sanctum-manifest-v1\n" || sha256(canonical_json)`. The prefix keeps a manifest
   signature from ever being valid as any other kind of signature.
2. **What is covered.** `name`, `version`, `checksum`, `detected`, plus two new fields:
   `publisher` (key id, `ed25519:<base64 of the public key>`) and `issued_at`. Covering
   `detected` means a signed tool whose scan later finds more capabilities than it
   declared is flagged, not silently widened.
3. **Algorithm.** Ed25519 (`ed25519-dalek`). Minisign, which the updater already trusts, is
   Ed25519 too, so one primitive covers both. Keys are separate: the updater key must
   never sign tools, and a tool key must never be able to sign an update.
4. **Distribution.** A signed tool travels as the HTML plus a detached
   `index.html.sanctum-sig` JSON file (`{manifest, signature}`), so the HTML is unchanged
   and its SHA-256 stays the version id.
5. **Trust anchors.** One Enigma community root key compiled into the binary, the same way
   the updater's minisign key is, plus any keys pinned by policy (stage 2).
6. **Key custody.** Publisher signing keys on hardware: a YubiKey (OpenPGP Ed25519, or
   PIV with P-256 if Ed25519 is not available) or a cloud HSM. The root key is offline
   and used only to sign publisher keys.

UI: Inspect already shows `Signed: Yes / Unsigned`. Add the publisher name and key id,
and a mismatch warning when the scan does not match the signed `detected` list.

## Stage 2: organisation policy (`policy.rs`)

A read-only policy file deployed by MDM (macOS configuration profile, Windows registry
or GPO, `/etc/sanctum/policy.json` on Linux). The stub's structure stands. Two additions
institutions will ask for:

- `pinned_checksums`: an allow-list of exact SHA-256 values. The strongest control, and
  it works before any signing exists: IT reviews the OTP vault once and pins its hash.
- `max_capabilities` per publisher: for example, the Enigma publisher may be granted
  `storage` and `smartcard:a0000005272101` and nothing else, whatever a future version
  asks for.

Enforcement lives in `open_tool_window`, next to the integrity check, so a policy
violation refuses the window the same way a checksum mismatch does.

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
    "checksum": "sha256:…",
    "name": "OTP Vault",
    "version": "1.0.0",
    "publisher": "ed25519:…",
    "manifest_sig": "…",          // the stage 1 signature
    "attestation": "https://…/attestations/…", // stage 0 bundle
    "published_at": "2026-09-26T00:00:00Z",
    "revoked": false,
    "revoked_reason": null
  }]
}
```

The client runs in Rust on a timer, never in a tool window:

1. Fetch index and signature; verify against the root key; refuse a `version` lower than
   the last one seen; warn when past `expires`.
2. For each library version, look up its checksum. Set a badge: *registry-verified*,
   *unlisted*, or *revoked*.
3. A revoked checksum is quarantined exactly like a tampered file.

For deployments that need key rotation, threshold signing (for example two of three
YubiKeys for the root) and separate roles, adopt TUF (The Update Framework) with the
`tough` crate instead of the single-signature index. The index format above maps onto
TUF's targets metadata, so moving to it later does not change what publishers submit.

## Publishing the OTP vault through this path

1. Merge `examples/otp-vault/` → the Examples workflow attests `index.html` (stage 0).
2. Sign the manifest with the Enigma publisher key held on a YubiKey (stage 1), commit
   `index.html.sanctum-sig` next to it.
3. Add its checksum to `registry/index.json`, sign the index with the root key, publish
   (stage 3).
4. A customer's policy pins that checksum or trusts the Enigma publisher with
   `max_capabilities: ["storage", "smartcard:a0000005272101"]` (stage 2).

## Order of work

| Stage | Sanctum change | Value to an institution |
|---|---|---|
| 0 | None (workflow only) | Verifiable build provenance today |
| 2a | `pinned_checksums` only | Hash allow-listing without any key management |
| 1 | Manifest signing and verification | Publisher identity inside the app |
| 2b | Full policy file | Central enforcement |
| 3 | Registry index client | Revocation and fleet-wide status |

`pinned_checksums` is listed before signing because it needs no keys, no server and no
format decisions, and covers the most common enterprise request: only these reviewed
files may run.
