// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Runs every vector in `spec/registry/vectors` through the Rust verifier. The Node
//! reference (`spec/registry/reference.mjs`) is tested against the same files, so the two
//! implementations cannot disagree about a registry without one of these suites failing.

use sanctum_bundle::registry::{
    check_asset, check_detail, verify_index, verify_revocations, AppEntry, Asset, IndexInput,
    LastSeen, RegistryError, RegistryTrust, RevocationsInput,
};
use sanctum_bundle::{parse_key_id, Anchor};
use serde_json::{json, Value};
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../spec/registry/vectors")
}

fn read(rel: &str) -> Vec<u8> {
    std::fs::read(dir().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

fn manifest() -> Value {
    serde_json::from_slice(&read("vectors.json")).unwrap()
}

fn anchors(m: &Value, names: &Value) -> Vec<Anchor> {
    names
        .as_array()
        .unwrap()
        .iter()
        .map(|n| {
            let k = &m["keys"][n.as_str().unwrap()];
            Anchor {
                key: parse_key_id(k["keyid"].as_str().unwrap()).unwrap(),
                name: k["name"].as_str().unwrap().to_string(),
            }
        })
        .collect()
}

fn last_seen(c: &Value) -> Option<LastSeen> {
    c.get("last_seen").map(|l| LastSeen {
        serial: l["serial"].as_u64().unwrap(),
        sha256: l["sha256"].as_str().unwrap().to_string(),
    })
}

fn verdict(trust: &RegistryTrust, stale: bool) -> Value {
    match trust {
        RegistryTrust::Anchored { publisher } => {
            json!({"result": "ok", "trust": "anchored", "publisher": publisher, "stale": stale})
        }
        RegistryTrust::Unanchored { reason } => {
            json!({"result": "ok", "trust": "unanchored", "reason": reason, "stale": stale})
        }
    }
}

fn failure(e: &RegistryError) -> Value {
    json!({"result": "error", "error": e.code()})
}

fn run(m: &Value, c: &Value) -> Value {
    let kind = c["kind"].as_str().unwrap();
    match kind {
        "index" => {
            let a = anchors(m, &c["anchors"]);
            let seen = last_seen(c);
            let index = read(c["index"].as_str().unwrap());
            let sig = read(c["sig"].as_str().unwrap());
            match verify_index(&IndexInput {
                index_bytes: &index,
                sig_bytes: &sig,
                anchors: &a,
                now: c["now"].as_i64().unwrap(),
                expected_id: c["expected_id"].as_str().unwrap(),
                last_seen: seen.as_ref(),
            }) {
                Ok(v) => verdict(&v.trust, v.stale),
                Err(e) => failure(&e),
            }
        }
        "revocations" => {
            let a = anchors(m, &c["anchors"]);
            let seen = last_seen(c);
            let bytes = read(c["file"].as_str().unwrap());
            let sig = read(c["sig"].as_str().unwrap());
            match verify_revocations(&RevocationsInput {
                bytes: &bytes,
                sig_bytes: &sig,
                anchors: &a,
                now: c["now"].as_i64().unwrap(),
                expected_id: c["expected_id"].as_str().unwrap(),
                last_seen: seen.as_ref(),
            }) {
                Ok(v) => verdict(&v.trust, v.stale),
                Err(e) => failure(&e),
            }
        }
        "detail" => {
            let entry: AppEntry = serde_json::from_value(c["entry"].clone()).unwrap();
            match check_detail(&entry, &read(c["file"].as_str().unwrap())) {
                Ok(_) => json!({"result": "ok"}),
                Err(e) => failure(&e),
            }
        }
        "asset" => {
            let entry: Asset = serde_json::from_value(c["entry"].clone()).unwrap();
            match check_asset(&entry, &read(c["file"].as_str().unwrap())) {
                Ok(()) => json!({"result": "ok"}),
                Err(e) => failure(&e),
            }
        }
        other => panic!("unknown vector kind {other}"),
    }
}

#[test]
fn every_vector_gets_the_verdict_it_declares() {
    let m = manifest();
    let cases = m["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 55,
        "expected the full vector set, found {}",
        cases.len()
    );
    let mut wrong = Vec::new();
    for c in cases {
        let got = run(&m, c);
        if got != c["expect"] {
            wrong.push(format!(
                "{}: expected {}, got {}",
                c["name"].as_str().unwrap(),
                c["expect"],
                got
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "disagreements with the spec:\n{}",
        wrong.join("\n")
    );
}

#[test]
fn the_production_root_is_not_among_the_test_anchors() {
    // The vectors use test keys only. If a production anchor ever appeared here, a vector
    // result would say nothing about the real trust path.
    let m = manifest();
    for (_, k) in m["keys"].as_object().unwrap() {
        assert_ne!(
            k["keyid"].as_str().unwrap(),
            "ed25519:GmNzEGh_57SWBOBLNV7kEnhykqoCkcCCMAnbkh0IVHY"
        );
    }
}

#[test]
fn flipping_any_single_byte_of_a_signed_index_is_rejected() {
    let m = manifest();
    let c = m["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "index_root_signed")
        .unwrap();
    let a = anchors(&m, &c["anchors"]);
    let original = read(c["index"].as_str().unwrap());
    let sig = read(c["sig"].as_str().unwrap());
    let input = |bytes: &[u8]| {
        verify_index(&IndexInput {
            index_bytes: bytes,
            sig_bytes: &sig,
            anchors: &a,
            now: c["now"].as_i64().unwrap(),
            expected_id: c["expected_id"].as_str().unwrap(),
            last_seen: None,
        })
        .map(|_| ())
    };
    assert!(input(&original).is_ok());
    for i in 0..original.len() {
        let mut copy = original.clone();
        copy[i] ^= 1;
        assert_eq!(
            input(&copy).unwrap_err().code(),
            "bad_signature",
            "byte {i}"
        );
    }
}

#[test]
fn oversize_files_are_refused_before_any_parsing() {
    let big = vec![b' '; 2 * 1024 * 1024 + 1];
    let e = verify_index(&IndexInput {
        index_bytes: &big,
        sig_bytes: b"{}",
        anchors: &[],
        now: 0,
        expected_id: "registry:x.y",
        last_seen: None,
    })
    .unwrap_err();
    assert_eq!(e.code(), "too_large");
    let big = vec![b' '; 256 * 1024 + 1];
    let e = verify_revocations(&RevocationsInput {
        bytes: &big,
        sig_bytes: b"{}",
        anchors: &[],
        now: 0,
        expected_id: "registry:x.y",
        last_seen: None,
    })
    .unwrap_err();
    assert_eq!(e.code(), "too_large");
}

#[test]
fn an_oversize_signature_file_is_refused_before_it_is_parsed() {
    let m = manifest();
    let c = m["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "index_root_signed")
        .unwrap();
    let index = read(c["index"].as_str().unwrap());
    let big_sig = vec![b' '; 16 * 1024 + 1];
    let e = verify_index(&IndexInput {
        index_bytes: &index,
        sig_bytes: &big_sig,
        anchors: &anchors(&m, &c["anchors"]),
        now: c["now"].as_i64().unwrap(),
        expected_id: c["expected_id"].as_str().unwrap(),
        last_seen: None,
    })
    .unwrap_err();
    assert_eq!(e.code(), "too_large");
}
