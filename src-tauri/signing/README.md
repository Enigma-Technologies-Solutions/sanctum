# Tool Signing — v1

## Purpose
Signing provides publisher identity and tamper-evidence beyond SHA-256 checksums. A
signed tool can be traced to a specific keypair; the registry can revoke individual
keys without affecting other publishers.

## Planned algorithm
Ed25519 (deterministic, fast, 64-byte signatures, small public keys).

**Signed data:** `sha256(canonical_manifest_json)` where canonical = sorted keys, no
whitespace. Canonical serialisation is fixed at v1 to prevent envelope attacks.

## Key management (v1 scope)
- Each publisher generates an Ed25519 keypair locally.
- Public keys are submitted to the Sanctum registry for inclusion in the trust store.
- Private keys are **never** transmitted; signing happens offline, in the publisher's CI.

## Platform codesign (v1 scope)
| Platform | Mechanism |
|----------|-----------|
| macOS | Apple notarization (Developer ID Application cert, `xcrun notarytool`) |
| Windows | Authenticode (EV code-signing cert, `signtool.exe`) or Azure Trusted Signing |
| Linux | GPG detached signature over the `.html` + manifest bundle |

Platform codesign is orthogonal to the Ed25519 tool manifest signature — both can
be present simultaneously.

## Hardware-backed keys (v2 scope)
Secure Enclave (macOS T-series / M-series) or TPM 2.0 for publisher key storage.

## Seam
`src-tauri/src/signing.rs` contains the `verify_signature` stub that will call into
a native Ed25519 verifier once key management is implemented.
