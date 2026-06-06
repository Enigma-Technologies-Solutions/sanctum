// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

/// Signature verification seam — Ed25519.
///
/// If a tool manifest includes a `signature` field, `verify_signature` checks
/// it against the known publisher key. Key management (loading, rotation,
/// trust anchors) is a v1 concern. In v0 we only gate on the presence of a
/// signature — if it's missing, the tool is shown as "unsigned" but still
/// runs (capabilities remain empty regardless).
///
/// In v1:
///   • Each publisher has an Ed25519 keypair. The public key is distributed
///     via the registry or pinned in the org policy file.
///   • Sanctum ships with a Sanctum-operated root key for community tools.
///   • The signature covers: sha256(manifest_json_canonical).
///   • Hardware-backed keys (Secure Enclave / TPM) are a v2 concern.
use crate::models::ToolManifest;

/// Verify a signature over a manifest.
///
/// v0: returns Ok(false) when no signature is present (unsigned),
/// or Err if the signature field is present but key management isn't
/// implemented yet. This allows the rest of the system to distinguish
/// "unsigned" from "signature present but unverifiable".
pub fn verify_signature(manifest: &ToolManifest) -> Result<bool, String> {
    match &manifest.signature {
        None => Ok(false), // unsigned — allowed in v0, flagged in UI
        Some(_sig) => {
            // v0-todo(v1): load publisher public key from policy / registry,
            // verify Ed25519(sig, sha256(canonical_manifest_json))
            Err("Signature verification not yet implemented (v1)".into())
        }
    }
}
