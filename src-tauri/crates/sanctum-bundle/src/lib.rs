// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Signed tool bundles: the file format, signing and verification.
//!
//! No Tauri, no database, no scanner. The app calls [`verify`]; the CLI calls [`sign_bundle`]
//! and [`issue_certificate`]. See `docs/registry.md` for the design and the rules this code
//! is held to. The one that matters here: **a valid signature proves who published these
//! bytes and that they are unchanged. It grants nothing.**
//!
//! A statement is signed as the exact bytes the publisher serialised, carried base64url in
//! the envelope, so no canonical-JSON step exists for two implementations to disagree about.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

pub const BUNDLE_FORMAT: &str = "sanctum-bundle/1";
pub const STATEMENT_SCHEMA: u32 = 1;
const STATEMENT_DOMAIN: &[u8] = b"sanctum-statement-v1\n";
const CERT_DOMAIN: &[u8] = b"sanctum-publisher-cert-v1\n";
const KEY_PREFIX: &str = "ed25519:";
/// Upper bound on a bundle we will parse. Tools are single HTML files; this is generous.
pub const MAX_BUNDLE_BYTES: usize = 32 * 1024 * 1024;

// ── Wire types ────────────────────────────────────────────────────────────────

/// What the publisher signs. Not `ToolManifest`: that is derived locally at install time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Statement {
    pub schema: u32,
    /// Stable identity, e.g. `sh.enigma.otp-vault`. Maps to one library tool.
    pub app_id: String,
    pub name: String,
    /// Publisher's version: dotted numbers, e.g. `1.0.0`.
    pub version: String,
    /// `sha256:<hex>` of the HTML, byte for byte.
    pub checksum: String,
    /// Capabilities the publisher says the file uses, in the app's `DetectedCapability`
    /// JSON shape. Opaque here; the app compares it against its own scan.
    pub declared: Vec<serde_json::Value>,
    pub issued_at: i64,
}

/// A publisher certificate, signed by a trust anchor.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Certificate {
    pub schema: u32,
    /// Key id of the publisher key being vouched for.
    pub subject: String,
    /// Display name of the publisher.
    pub name: String,
    pub not_before: i64,
    pub not_after: i64,
    /// `app_id` prefixes this publisher may sign. Empty means none.
    pub scope: Vec<String>,
}

/// A signed blob: payload bytes, signature, and the key that made it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignedBlob {
    pub payload: String,
    pub sig: String,
    pub keyid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignatureEnvelope {
    pub payload: String,
    pub sig: String,
    pub keyid: String,
    /// Zero or one publisher certificate.
    #[serde(default)]
    pub chain: Vec<SignedBlob>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Bundle {
    pub format: String,
    pub html: String,
    pub signature: SignatureEnvelope,
}

// ── Verification result ───────────────────────────────────────────────────────

/// A key Sanctum trusts to say who a publisher is.
#[derive(Debug, Clone)]
pub struct Anchor {
    pub key: VerifyingKey,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trust {
    /// Signer is an anchor, or holds a valid certificate from one.
    Anchored { publisher: String },
    /// The signature is valid but nothing ties the signer to an anchor.
    Unanchored { reason: Option<String> },
}

#[derive(Debug, Clone)]
pub struct Verification {
    pub statement: Statement,
    pub signer_key: String,
    pub trust: Trust,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    Malformed(String),
    UnsupportedFormat(String),
    BadSignature,
    ChecksumMismatch { signed: String, actual: String },
}

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VerifyError::Malformed(m) => write!(f, "malformed bundle: {m}"),
            VerifyError::UnsupportedFormat(s) => write!(f, "unsupported bundle format: {s}"),
            VerifyError::BadSignature => write!(f, "signature does not verify"),
            VerifyError::ChecksumMismatch { signed, actual } => write!(
                f,
                "file does not match the signed checksum (signed {signed}, file is {actual})"
            ),
        }
    }
}

impl std::error::Error for VerifyError {}

// ── Keys and encoding ─────────────────────────────────────────────────────────

pub fn key_id(key: &VerifyingKey) -> String {
    format!("{KEY_PREFIX}{}", B64.encode(key.as_bytes()))
}

pub fn parse_key_id(id: &str) -> Result<VerifyingKey, String> {
    let raw = id
        .strip_prefix(KEY_PREFIX)
        .ok_or_else(|| format!("key id must start with {KEY_PREFIX}"))?;
    let bytes = B64
        .decode(raw)
        .map_err(|_| "key id is not base64url".to_string())?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "key id is not 32 bytes".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|_| "not a valid Ed25519 public key".to_string())
}

pub fn checksum_of(html: &str) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(html.as_bytes())))
}

fn signed_message(domain: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(domain.len() + payload.len());
    m.extend_from_slice(domain);
    m.extend_from_slice(payload);
    m
}

fn verify_blob(
    domain: &[u8],
    payload_b64: &str,
    sig_b64: &str,
    keyid: &str,
) -> Result<(Vec<u8>, VerifyingKey), VerifyError> {
    let key = parse_key_id(keyid).map_err(VerifyError::Malformed)?;
    let payload = B64
        .decode(payload_b64)
        .map_err(|_| VerifyError::Malformed("payload is not base64url".into()))?;
    let sig_bytes = B64
        .decode(sig_b64)
        .map_err(|_| VerifyError::Malformed("signature is not base64url".into()))?;
    let sig = ed25519_dalek::Signature::from_slice(&sig_bytes)
        .map_err(|_| VerifyError::Malformed("signature is not 64 bytes".into()))?;
    // verify_strict also rejects small-order keys and non-canonical signatures.
    key.verify_strict(&signed_message(domain, &payload), &sig)
        .map_err(|_| VerifyError::BadSignature)?;
    Ok((payload, key))
}

// ── Validation of statement fields ────────────────────────────────────────────

/// `a.b.c`: one or more dot-separated non-negative integers.
pub fn parse_version(v: &str) -> Option<Vec<u64>> {
    if v.is_empty() || v.len() > 64 {
        return None;
    }
    v.split('.').map(|p| p.parse::<u64>().ok()).collect()
}

/// Compare dotted versions, treating missing trailing parts as zero.
pub fn compare_versions(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    let n = a.len().max(b.len());
    for i in 0..n {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'_'
        })
        && !id.starts_with('.')
        && !id.ends_with('.')
        && !id.contains("..")
}

fn check_statement(s: &Statement) -> Result<(), VerifyError> {
    if s.schema != STATEMENT_SCHEMA {
        return Err(VerifyError::Malformed(format!(
            "unsupported statement schema {}",
            s.schema
        )));
    }
    if !valid_app_id(&s.app_id) {
        return Err(VerifyError::Malformed("invalid app_id".into()));
    }
    if parse_version(&s.version).is_none() {
        return Err(VerifyError::Malformed("invalid version".into()));
    }
    if s.name.trim().is_empty() || s.name.len() > 200 {
        return Err(VerifyError::Malformed("invalid name".into()));
    }
    let hex_part = s.checksum.strip_prefix("sha256:").unwrap_or("");
    if hex_part.len() != 64 || !hex_part.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(VerifyError::Malformed("invalid checksum".into()));
    }
    Ok(())
}

// ── Signing ───────────────────────────────────────────────────────────────────

/// Fields the publisher chooses; the checksum is computed from the HTML.
pub struct StatementInput {
    pub app_id: String,
    pub name: String,
    pub version: String,
    pub declared: Vec<serde_json::Value>,
    pub issued_at: i64,
}

pub fn sign_bundle(
    html: &str,
    input: StatementInput,
    key: &SigningKey,
    cert: Option<SignedBlob>,
) -> Result<Bundle, String> {
    let statement = Statement {
        schema: STATEMENT_SCHEMA,
        app_id: input.app_id,
        name: input.name,
        version: input.version,
        checksum: checksum_of(html),
        declared: input.declared,
        issued_at: input.issued_at,
    };
    check_statement(&statement).map_err(|e| e.to_string())?;
    let payload = serde_json::to_vec(&statement).map_err(|e| e.to_string())?;
    let sig = key.sign(&signed_message(STATEMENT_DOMAIN, &payload));
    Ok(Bundle {
        format: BUNDLE_FORMAT.into(),
        html: html.into(),
        signature: SignatureEnvelope {
            payload: B64.encode(&payload),
            sig: B64.encode(sig.to_bytes()),
            keyid: key_id(&key.verifying_key()),
            chain: cert.into_iter().collect(),
        },
    })
}

pub fn issue_certificate(issuer: &SigningKey, cert: &Certificate) -> Result<SignedBlob, String> {
    parse_key_id(&cert.subject)?;
    let payload = serde_json::to_vec(cert).map_err(|e| e.to_string())?;
    let sig = issuer.sign(&signed_message(CERT_DOMAIN, &payload));
    Ok(SignedBlob {
        payload: B64.encode(&payload),
        sig: B64.encode(sig.to_bytes()),
        keyid: key_id(&issuer.verifying_key()),
    })
}

// ── Verification ──────────────────────────────────────────────────────────────

pub fn parse_bundle(json: &str) -> Result<Bundle, VerifyError> {
    if json.len() > MAX_BUNDLE_BYTES {
        return Err(VerifyError::Malformed("bundle is too large".into()));
    }
    let bundle: Bundle =
        serde_json::from_str(json).map_err(|e| VerifyError::Malformed(e.to_string()))?;
    if bundle.format != BUNDLE_FORMAT {
        return Err(VerifyError::UnsupportedFormat(bundle.format));
    }
    Ok(bundle)
}

/// Check the signature and the file hash, then decide whether the signer is anchored.
///
/// `Err` means the bundle must not be installed. `Ok` with [`Trust::Unanchored`] means it is
/// a genuine signature by an unknown party: install at the same trust as a loose file.
pub fn verify(bundle: &Bundle, anchors: &[Anchor], now: i64) -> Result<Verification, VerifyError> {
    if bundle.format != BUNDLE_FORMAT {
        return Err(VerifyError::UnsupportedFormat(bundle.format.clone()));
    }
    let env = &bundle.signature;
    let (payload, signer) = verify_blob(STATEMENT_DOMAIN, &env.payload, &env.sig, &env.keyid)?;
    let statement: Statement = serde_json::from_slice(&payload)
        .map_err(|e| VerifyError::Malformed(format!("statement: {e}")))?;
    check_statement(&statement)?;

    let actual = checksum_of(&bundle.html);
    if actual != statement.checksum {
        return Err(VerifyError::ChecksumMismatch {
            signed: statement.checksum,
            actual,
        });
    }

    let signer_id = key_id(&signer);
    let trust = if let Some(a) = anchors
        .iter()
        .find(|a| a.key.as_bytes() == signer.as_bytes())
    {
        Trust::Anchored {
            publisher: a.name.clone(),
        }
    } else {
        match env.chain.as_slice() {
            [] => Trust::Unanchored { reason: None },
            [cert] => match check_certificate(cert, &signer_id, &statement.app_id, anchors, now) {
                Ok(name) => Trust::Anchored { publisher: name },
                Err(reason) => Trust::Unanchored {
                    reason: Some(reason),
                },
            },
            _ => Trust::Unanchored {
                reason: Some("certificate chains longer than one are not supported".into()),
            },
        }
    };

    Ok(Verification {
        statement,
        signer_key: signer_id,
        trust,
    })
}

/// Returns the publisher name if `cert` validly vouches for `signer_id` to sign `app_id`.
fn check_certificate(
    cert: &SignedBlob,
    signer_id: &str,
    app_id: &str,
    anchors: &[Anchor],
    now: i64,
) -> Result<String, String> {
    // The issuer must be an anchor before its signature is worth checking.
    let issuer = parse_key_id(&cert.keyid)?;
    if !anchors
        .iter()
        .any(|a| a.key.as_bytes() == issuer.as_bytes())
    {
        return Err("certificate was not issued by a trusted key".into());
    }
    let (payload, _) = verify_blob(CERT_DOMAIN, &cert.payload, &cert.sig, &cert.keyid)
        .map_err(|e| format!("certificate: {e}"))?;
    let c: Certificate =
        serde_json::from_slice(&payload).map_err(|e| format!("certificate: {e}"))?;
    if c.schema != STATEMENT_SCHEMA {
        return Err("certificate has an unsupported schema".into());
    }
    if c.subject != signer_id {
        return Err("certificate is for a different key".into());
    }
    if now < c.not_before {
        return Err("certificate is not yet valid".into());
    }
    if now > c.not_after {
        return Err("certificate has expired".into());
    }
    if !c
        .scope
        .iter()
        .any(|p| !p.is_empty() && app_id.starts_with(p.as_str()))
    {
        return Err("certificate does not cover this app_id".into());
    }
    Ok(c.name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_core::OsRng;

    const HTML: &str = "<!doctype html><title>Vault</title><p>hello";
    const NOW: i64 = 1_790_000_000;

    fn input() -> StatementInput {
        StatementInput {
            app_id: "sh.enigma.otp-vault".into(),
            name: "OTP Vault".into(),
            version: "1.0.0".into(),
            declared: vec![serde_json::json!("storage")],
            issued_at: NOW,
        }
    }

    fn keypair() -> SigningKey {
        SigningKey::generate(&mut OsRng)
    }

    fn anchor(k: &SigningKey, name: &str) -> Anchor {
        Anchor {
            key: k.verifying_key(),
            name: name.into(),
        }
    }

    fn cert_for(root: &SigningKey, subject: &SigningKey, scope: &[&str]) -> SignedBlob {
        issue_certificate(
            root,
            &Certificate {
                schema: 1,
                subject: key_id(&subject.verifying_key()),
                name: "Enigma".into(),
                not_before: NOW - 100,
                not_after: NOW + 100,
                scope: scope.iter().map(|s| s.to_string()).collect(),
            },
        )
        .unwrap()
    }

    #[test]
    fn roundtrip_with_anchored_key() {
        let k = keypair();
        let b = sign_bundle(HTML, input(), &k, None).unwrap();
        let v = verify(&b, &[anchor(&k, "Direct")], NOW).unwrap();
        assert_eq!(
            v.trust,
            Trust::Anchored {
                publisher: "Direct".into()
            }
        );
        assert_eq!(v.statement.app_id, "sh.enigma.otp-vault");
        assert_eq!(v.statement.checksum, checksum_of(HTML));
    }

    #[test]
    fn survives_json_roundtrip() {
        let k = keypair();
        let b = sign_bundle(HTML, input(), &k, None).unwrap();
        let text = serde_json::to_string(&b).unwrap();
        let again = parse_bundle(&text).unwrap();
        assert!(verify(&again, &[], NOW).is_ok());
    }

    #[test]
    fn unknown_signer_is_unanchored_not_rejected() {
        let k = keypair();
        let other = keypair();
        let b = sign_bundle(HTML, input(), &k, None).unwrap();
        let v = verify(&b, &[anchor(&other, "Other")], NOW).unwrap();
        assert_eq!(v.trust, Trust::Unanchored { reason: None });
    }

    #[test]
    fn tampered_html_is_rejected() {
        let k = keypair();
        let mut b = sign_bundle(HTML, input(), &k, None).unwrap();
        b.html.push_str("<script>steal()</script>");
        assert!(matches!(
            verify(&b, &[anchor(&k, "x")], NOW),
            Err(VerifyError::ChecksumMismatch { .. })
        ));
    }

    #[test]
    fn tampered_payload_is_rejected() {
        let k = keypair();
        let mut b = sign_bundle(HTML, input(), &k, None).unwrap();
        let mut st: Statement =
            serde_json::from_slice(&B64.decode(&b.signature.payload).unwrap()).unwrap();
        st.declared.push(serde_json::json!("camera"));
        b.signature.payload = B64.encode(serde_json::to_vec(&st).unwrap());
        assert_eq!(
            verify(&b, &[anchor(&k, "x")], NOW).unwrap_err(),
            VerifyError::BadSignature
        );
    }

    #[test]
    fn signature_from_a_different_key_is_rejected() {
        let k = keypair();
        let other = keypair();
        let mut b = sign_bundle(HTML, input(), &k, None).unwrap();
        b.signature.keyid = key_id(&other.verifying_key());
        assert_eq!(verify(&b, &[], NOW).unwrap_err(), VerifyError::BadSignature);
    }

    #[test]
    fn certificate_makes_a_publisher_key_anchored() {
        let root = keypair();
        let publisher = keypair();
        let cert = cert_for(&root, &publisher, &["sh.enigma."]);
        let b = sign_bundle(HTML, input(), &publisher, Some(cert)).unwrap();
        let v = verify(&b, &[anchor(&root, "Root")], NOW).unwrap();
        assert_eq!(
            v.trust,
            Trust::Anchored {
                publisher: "Enigma".into()
            }
        );
    }

    #[test]
    fn certificate_outside_scope_is_unanchored() {
        let root = keypair();
        let publisher = keypair();
        let cert = cert_for(&root, &publisher, &["com.other."]);
        let b = sign_bundle(HTML, input(), &publisher, Some(cert)).unwrap();
        let v = verify(&b, &[anchor(&root, "Root")], NOW).unwrap();
        assert!(matches!(v.trust, Trust::Unanchored { reason: Some(_) }));
    }

    #[test]
    fn empty_scope_covers_nothing() {
        let root = keypair();
        let publisher = keypair();
        let cert = cert_for(&root, &publisher, &[]);
        let b = sign_bundle(HTML, input(), &publisher, Some(cert)).unwrap();
        let v = verify(&b, &[anchor(&root, "Root")], NOW).unwrap();
        assert!(matches!(v.trust, Trust::Unanchored { .. }));
    }

    #[test]
    fn expired_and_not_yet_valid_certificates_are_unanchored() {
        let root = keypair();
        let publisher = keypair();
        let cert = cert_for(&root, &publisher, &["sh.enigma."]);
        let b = sign_bundle(HTML, input(), &publisher, Some(cert)).unwrap();
        let a = [anchor(&root, "Root")];
        assert!(matches!(
            verify(&b, &a, NOW + 1_000).unwrap().trust,
            Trust::Unanchored { .. }
        ));
        assert!(matches!(
            verify(&b, &a, NOW - 1_000).unwrap().trust,
            Trust::Unanchored { .. }
        ));
    }

    #[test]
    fn certificate_from_an_untrusted_issuer_is_unanchored() {
        let fake_root = keypair();
        let real_root = keypair();
        let publisher = keypair();
        let cert = cert_for(&fake_root, &publisher, &["sh.enigma."]);
        let b = sign_bundle(HTML, input(), &publisher, Some(cert)).unwrap();
        let v = verify(&b, &[anchor(&real_root, "Root")], NOW).unwrap();
        assert!(matches!(v.trust, Trust::Unanchored { .. }));
    }

    #[test]
    fn certificate_for_another_key_cannot_be_borrowed() {
        let root = keypair();
        let publisher = keypair();
        let thief = keypair();
        let cert = cert_for(&root, &publisher, &["sh.enigma."]);
        let b = sign_bundle(HTML, input(), &thief, Some(cert)).unwrap();
        let v = verify(&b, &[anchor(&root, "Root")], NOW).unwrap();
        assert!(matches!(v.trust, Trust::Unanchored { .. }));
    }

    #[test]
    fn a_statement_signature_is_not_a_valid_certificate() {
        // Domain separation: sign a certificate body as if it were a statement.
        let root = keypair();
        let publisher = keypair();
        let body = serde_json::to_vec(&Certificate {
            schema: 1,
            subject: key_id(&publisher.verifying_key()),
            name: "Forged".into(),
            not_before: 0,
            not_after: i64::MAX,
            scope: vec!["".into(), "sh.".into()],
        })
        .unwrap();
        let sig = root.sign(&signed_message(STATEMENT_DOMAIN, &body));
        let forged = SignedBlob {
            payload: B64.encode(&body),
            sig: B64.encode(sig.to_bytes()),
            keyid: key_id(&root.verifying_key()),
        };
        let b = sign_bundle(HTML, input(), &publisher, Some(forged)).unwrap();
        let v = verify(&b, &[anchor(&root, "Root")], NOW).unwrap();
        assert!(matches!(v.trust, Trust::Unanchored { .. }));
    }

    #[test]
    fn rejects_bad_statement_fields() {
        let k = keypair();
        for bad in [
            StatementInput {
                app_id: "Has Space".into(),
                ..input()
            },
            StatementInput {
                app_id: "..".into(),
                ..input()
            },
            StatementInput {
                version: "1.x".into(),
                ..input()
            },
            StatementInput {
                name: " ".into(),
                ..input()
            },
        ] {
            assert!(sign_bundle(HTML, bad, &k, None).is_err());
        }
    }

    #[test]
    fn unknown_statement_fields_are_rejected() {
        let k = keypair();
        let b = sign_bundle(HTML, input(), &k, None).unwrap();
        let mut v: serde_json::Value =
            serde_json::from_slice(&B64.decode(&b.signature.payload).unwrap()).unwrap();
        v["grant"] = serde_json::json!(["net"]);
        let payload = serde_json::to_vec(&v).unwrap();
        let sig = k.sign(&signed_message(STATEMENT_DOMAIN, &payload));
        let mut b2 = b.clone();
        b2.signature.payload = B64.encode(&payload);
        b2.signature.sig = B64.encode(sig.to_bytes());
        assert!(matches!(
            verify(&b2, &[], NOW),
            Err(VerifyError::Malformed(_))
        ));
    }

    #[test]
    fn wrong_format_and_garbage_are_rejected() {
        assert!(matches!(
            parse_bundle("not json"),
            Err(VerifyError::Malformed(_))
        ));
        let k = keypair();
        let mut b = sign_bundle(HTML, input(), &k, None).unwrap();
        b.format = "sanctum-bundle/2".into();
        assert!(matches!(
            parse_bundle(&serde_json::to_string(&b).unwrap()),
            Err(VerifyError::UnsupportedFormat(_))
        ));
    }

    #[test]
    fn version_comparison() {
        use std::cmp::Ordering::*;
        let p = |s| parse_version(s).unwrap();
        assert_eq!(compare_versions(&p("1.0.1"), &p("1.0.0")), Greater);
        assert_eq!(compare_versions(&p("1.0"), &p("1.0.0")), Equal);
        assert_eq!(compare_versions(&p("1.10"), &p("1.9")), Greater);
        assert_eq!(compare_versions(&p("2"), &p("10")), Less);
        assert!(parse_version("").is_none());
        assert!(parse_version("1..2").is_none());
        assert!(parse_version("v1").is_none());
    }
}
