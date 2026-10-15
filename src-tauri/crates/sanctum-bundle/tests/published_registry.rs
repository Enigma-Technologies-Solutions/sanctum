// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! The registry actually published at `web/registry/v1` must verify against the Enigma root
//! compiled into the app, with the Rust verifier a client will use. The Node verifier checks
//! the same files in CI; this proves the two agree on real data, not just on vectors.

use sanctum_bundle::registry::{
    check_asset, check_detail, is_revoked, verify_index, verify_revocations, IndexInput,
    RegistryTrust, RevocationsInput,
};
use sanctum_bundle::{key_id, parse_bundle, parse_key_id, verify, Anchor, Trust};
use std::path::PathBuf;

const ROOT: &str = "ed25519:GmNzEGh_57SWBOBLNV7kEnhykqoCkcCCMAnbkh0IVHY";
const REGISTRY_ID: &str = "registry:sh.enigma.public";

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../web/registry/v1")
}

fn read(rel: &str) -> Vec<u8> {
    std::fs::read(dir().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// A fixed clock inside the validity of both the index and the registry certificate, so the
/// tests do not depend on today's date. The certificate is issued when the maintainer signs,
/// which is after the index was built, so the later of the two timestamps is used.
fn test_now() -> i64 {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
    let index: serde_json::Value = serde_json::from_slice(&read("index.json")).unwrap();
    let sig: serde_json::Value = serde_json::from_slice(&read("index.json.sig")).unwrap();
    let payload = B64
        .decode(
            sig["chain"][0]["payload"]
                .as_str()
                .expect("registry signature carries a certificate"),
        )
        .unwrap();
    let cert: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    index["issued_at"]
        .as_i64()
        .unwrap()
        .max(cert["not_before"].as_i64().unwrap())
        + 60
}

fn anchors() -> Vec<Anchor> {
    vec![Anchor {
        key: parse_key_id(ROOT).unwrap(),
        name: "Enigma Technologies Solutions".into(),
    }]
}

#[test]
fn the_compiled_in_root_in_this_test_is_the_one_in_trust_rs() {
    let trust = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/trust.rs"),
    )
    .unwrap();
    assert!(
        trust.contains(ROOT),
        "update ROOT in this test to match trust.rs"
    );
}

#[test]
fn the_published_registry_verifies_end_to_end() {
    let a = anchors();
    let now = test_now();

    let idx = verify_index(&IndexInput {
        index_bytes: &read("index.json"),
        sig_bytes: &read("index.json.sig"),
        anchors: &a,
        now,
        expected_id: REGISTRY_ID,
        last_seen: None,
    })
    .expect("published index verifies");
    assert_eq!(
        idx.trust,
        RegistryTrust::Anchored {
            publisher: "Enigma Technologies Solutions".into()
        }
    );
    assert!(!idx.stale);
    assert!(!idx.index.apps.is_empty());

    let rev = verify_revocations(&RevocationsInput {
        bytes: &read("revocations.json"),
        sig_bytes: &read("revocations.json.sig"),
        anchors: &a,
        now,
        expected_id: REGISTRY_ID,
        last_seen: None,
    })
    .expect("published revocations verify");
    assert!(matches!(rev.trust, RegistryTrust::Anchored { .. }));

    for app in &idx.index.apps {
        let detail = check_detail(app, &read(&app.detail.path)).expect("detail matches its hash");
        if let Some(icon) = &app.icon {
            check_asset(icon, &read(&icon.path)).expect("icon");
        }
        if let Some(manual) = &detail.manual {
            check_asset(manual, &read(&manual.path)).expect("manual");
        }
        for s in &detail.screenshots {
            let bytes = read(&s.path);
            assert_eq!(bytes.len() as u64, s.size);
        }
        for v in &app.versions {
            let bytes = read(&v.bundle.path);
            check_asset(&v.bundle, &bytes).expect("bundle matches its hash");
            assert!(
                !is_revoked(&rev.revocations, &v.checksum),
                "{} is revoked",
                app.app_id
            );

            // The bundle itself, verified the way the app does at install, must agree with
            // the index entry that pointed at it.
            let bundle = parse_bundle(std::str::from_utf8(&bytes).unwrap()).unwrap();
            let verified = verify(&bundle, &a, now).expect("bundle verifies");
            assert!(matches!(verified.trust, Trust::Anchored { .. }));
            let s = &verified.statement;
            assert_eq!(s.app_id, app.app_id);
            assert_eq!(s.version, v.version);
            assert_eq!(s.checksum, v.checksum);
            assert_eq!(s.declared, v.declared);
            assert_eq!(verified.signer_key, app.publisher.keyid);
            assert!(parse_key_id(&app.publisher.keyid).is_ok());
            assert_eq!(
                key_id(&parse_key_id(&app.publisher.keyid).unwrap()),
                app.publisher.keyid
            );
        }
    }
}

#[test]
fn the_published_registry_is_rejected_by_a_client_that_does_not_trust_the_root() {
    // No anchors at all: a genuine signature, but nothing ties it to a root.
    let now = test_now();
    let idx = verify_index(&IndexInput {
        index_bytes: &read("index.json"),
        sig_bytes: &read("index.json.sig"),
        anchors: &[],
        now,
        expected_id: REGISTRY_ID,
        last_seen: None,
    })
    .unwrap();
    assert!(matches!(idx.trust, RegistryTrust::Unanchored { .. }));
}

#[test]
fn the_published_registry_is_refused_under_another_id() {
    let now = test_now();
    let e = verify_index(&IndexInput {
        index_bytes: &read("index.json"),
        sig_bytes: &read("index.json.sig"),
        anchors: &anchors(),
        now,
        expected_id: "registry:sh.evil.public",
        last_seen: None,
    })
    .unwrap_err();
    assert_eq!(e.code(), "id_mismatch");
}
