// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Trust anchors compiled into the binary.
//!
//! An anchor says who a publisher is; it never says what a tool may do. Capabilities come
//! only from user approval (or, later, a pinned org policy). See `docs/registry.md`.
//!
//! Until the Enigma root key is generated and added below, nothing is anchored and every
//! signed bundle installs as "unknown signer". That is the safe default, not a bug.

use sanctum_bundle::{parse_key_id, Anchor};

/// `(key id, display name)`. Add the Enigma root here once it exists:
///
/// ```text
/// ("ed25519:<base64url public key>", "Enigma Technologies Solutions"),
/// ```
///
/// Key ids are public. The matching private key is never stored in this repository.
const COMPILED_ANCHORS: &[(&str, &str)] = &[];

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
    fn anchors_from_rejects_garbage() {
        let r = std::panic::catch_unwind(|| anchors_from(&[("ed25519:nope", "x")]));
        assert!(r.is_err());
    }
}
