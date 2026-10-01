// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Trust anchors compiled into the binary.
//!
//! An anchor says who a publisher is; it never says what a tool may do. Capabilities come
//! only from user approval (or, later, a pinned org policy). See `docs/registry.md`.
//!
//! The Enigma root key (generated 2026-09-30, private half kept offline by the maintainer)
//! anchors publisher certificates. With no anchors, every signed bundle would install as
//! "unknown signer", which is the safe default.

use sanctum_bundle::{parse_key_id, Anchor};

/// `(key id, display name)`. Key ids are public. The matching private keys are never stored
/// in this repository. The root signs publisher certificates only; it does not sign tools.
const COMPILED_ANCHORS: &[(&str, &str)] = &[(
    "ed25519:GmNzEGh_57SWBOBLNV7kEnhykqoCkcCCMAnbkh0IVHY",
    "Enigma Technologies Solutions",
)];

/// A trust anchor as shown in Settings. Public information only.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustAnchorInfo {
    pub name: String,
    pub key_id: String,
}

fn anchor_infos(list: &[(&str, &str)]) -> Vec<TrustAnchorInfo> {
    list.iter()
        .map(|(id, name)| TrustAnchorInfo {
            name: (*name).to_string(),
            key_id: (*id).to_string(),
        })
        .collect()
}

/// The publisher keys this build recognises. Read-only; nothing in the UI can change them.
#[tauri::command]
pub fn get_trust_anchors() -> Vec<TrustAnchorInfo> {
    anchor_infos(COMPILED_ANCHORS)
}

pub fn production_anchors() -> Vec<Anchor> {
    anchors_from(COMPILED_ANCHORS)
}

fn anchors_from(list: &[(&str, &str)]) -> Vec<Anchor> {
    list.iter()
        .map(|(id, name)| Anchor {
            // A malformed compiled-in key is a build-time mistake; fail loudly in tests
            // (see `compiled_anchors_parse`) rather than silently trusting nothing.
            key: parse_key_id(id).unwrap_or_else(|e| panic!("bad compiled trust anchor {id}: {e}")),
            name: (*name).to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_anchors_parse() {
        // Panics if any compiled-in anchor is malformed.
        let _ = production_anchors();
    }

    #[test]
    fn the_enigma_root_is_compiled_in() {
        let a = production_anchors();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].name, "Enigma Technologies Solutions");
        assert_eq!(
            sanctum_bundle::key_id(&a[0].key),
            "ed25519:GmNzEGh_57SWBOBLNV7kEnhykqoCkcCCMAnbkh0IVHY"
        );
    }

    #[test]
    fn the_settings_list_matches_the_anchors_used_for_verification() {
        let shown: Vec<String> = get_trust_anchors().into_iter().map(|a| a.key_id).collect();
        let used: Vec<String> = production_anchors()
            .iter()
            .map(|a| sanctum_bundle::key_id(&a.key))
            .collect();
        assert_eq!(shown, used);
    }

    #[test]
    fn anchors_from_rejects_garbage() {
        let r = std::panic::catch_unwind(|| anchors_from(&[("ed25519:nope", "x")]));
        assert!(r.is_err());
    }
}
