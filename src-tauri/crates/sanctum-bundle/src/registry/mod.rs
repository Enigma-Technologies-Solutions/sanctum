// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Reading a registry: verify `index.json` and `revocations.json`, and check the files they
//! point at. The format is in `docs/registry-format.md`; the Node reference in
//! `spec/registry/reference.mjs` does the same job, and both are tested against the signed
//! vectors in `spec/registry/vectors`.
//!
//! No network, no database, no Tauri. Callers hand in bytes and get a verdict. The order of
//! the checks is part of the spec: nothing is parsed before the signature verifies.
//!
//! **A registry never grants a capability.** A verified index says who published a catalogue
//! and that it is unaltered. Installing from it runs the normal bundle verification, local
//! scan and approval screen.

mod schema;

use crate::{
    key_id, verify_blob, verify_registry_signature, Anchor, Certificate, RegistryFile,
    RegistrySignature, VerifyError, CERT_DOMAIN, STATEMENT_SCHEMA,
};
use schema::{normalize_integers, validate, SchemaFile};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;

pub const INDEX_FORMAT: &str = "sanctum-registry/1";
pub const APP_FORMAT: &str = "sanctum-registry-app/1";
pub const REVOCATIONS_FORMAT: &str = "sanctum-registry-revocations/1";

pub const MAX_INDEX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_REVOCATIONS_BYTES: usize = 256 * 1024;
pub const MAX_DETAIL_BYTES: usize = 256 * 1024;
pub const MAX_SIG_BYTES: usize = 16 * 1024;
/// How far ahead of the local clock `issued_at` may be before a file is refused.
pub const SKEW_SECONDS: i64 = 24 * 60 * 60;

// ── Errors ────────────────────────────────────────────────────────────────────

/// A verification failure. The codes are part of the spec and match the vectors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    TooLarge(String),
    SigMalformed(String),
    BadSignature,
    MalformedJson(String),
    FormatUnsupported(String),
    SchemaInvalid(String),
    IdMismatch(String),
    FromFuture,
    Rollback { got: u64, seen: u64 },
    SerialReplay,
    SizeMismatch { got: usize, want: u64 },
    HashMismatch(String),
}

impl RegistryError {
    pub fn code(&self) -> &'static str {
        match self {
            RegistryError::TooLarge(_) => "too_large",
            RegistryError::SigMalformed(_) => "sig_malformed",
            RegistryError::BadSignature => "bad_signature",
            RegistryError::MalformedJson(_) => "malformed_json",
            RegistryError::FormatUnsupported(_) => "format_unsupported",
            RegistryError::SchemaInvalid(_) => "schema_invalid",
            RegistryError::IdMismatch(_) => "id_mismatch",
            RegistryError::FromFuture => "from_future",
            RegistryError::Rollback { .. } => "rollback",
            RegistryError::SerialReplay => "serial_replay",
            RegistryError::SizeMismatch { .. } => "size_mismatch",
            RegistryError::HashMismatch(_) => "hash_mismatch",
        }
    }
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistryError::TooLarge(what) => write!(f, "{what} is too large"),
            RegistryError::SigMalformed(m) => write!(f, "signature file is malformed: {m}"),
            RegistryError::BadSignature => write!(f, "signature does not verify"),
            RegistryError::MalformedJson(m) => write!(f, "not valid JSON: {m}"),
            RegistryError::FormatUnsupported(s) => write!(f, "unsupported format {s}"),
            RegistryError::SchemaInvalid(m) => write!(f, "does not follow the format: {m}"),
            RegistryError::IdMismatch(id) => write!(f, "belongs to a different registry: {id}"),
            RegistryError::FromFuture => write!(f, "is dated in the future"),
            RegistryError::Rollback { got, seen } => {
                write!(f, "serial {got} is older than {seen} already seen")
            }
            RegistryError::SerialReplay => {
                write!(f, "same serial as one already seen but different contents")
            }
            RegistryError::SizeMismatch { got, want } => {
                write!(f, "file is {got} bytes, the index says {want}")
            }
            RegistryError::HashMismatch(p) => write!(f, "{p} does not match its hash in the index"),
        }
    }
}

impl std::error::Error for RegistryError {}

// ── Documents ─────────────────────────────────────────────────────────────────

/// A file the index points at, with the hash and size it must have.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Publisher {
    pub keyid: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Free,
    /// Listed but not installable by a v1 client.
    Licensed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Public,
    Licensed,
}

/// Reserved. A v1 client parses it and never shows "Reviewed" because of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attestation {
    pub kind: String,
    pub keyid: String,
    pub sig: String,
    pub issued_at: i64,
    pub report: Asset,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VersionEntry {
    pub version: String,
    pub published_at: i64,
    pub bundle: Asset,
    /// `sha256:` of the tool's HTML. Equals the signed statement's checksum.
    pub checksum: String,
    /// Display data. The bundle's signed statement is authoritative.
    pub declared: Vec<Value>,
    #[serde(default)]
    pub attestations: Vec<Attestation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppEntry {
    pub app_id: String,
    pub name: String,
    pub summary: String,
    pub publisher: Publisher,
    pub access: Access,
    pub latest: String,
    #[serde(default)]
    pub icon: Option<Asset>,
    pub detail: Asset,
    pub versions: Vec<VersionEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Index {
    pub format: String,
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub serial: u64,
    pub issued_at: i64,
    pub expires: i64,
    #[serde(default)]
    pub mirrors: Vec<String>,
    #[serde(default)]
    pub revocations: Option<String>,
    pub apps: Vec<AppEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revocation {
    pub checksum: String,
    pub app_id: String,
    #[serde(default)]
    pub version: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub note: Option<String>,
    pub revoked_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revocations {
    pub format: String,
    pub registry: String,
    pub serial: u64,
    pub issued_at: i64,
    pub expires: i64,
    pub entries: Vec<Revocation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeItem {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangelogEntry {
    pub version: String,
    pub date: String,
    pub changes: Vec<ChangeItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screenshot {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub width: u32,
    pub height: u32,
    pub alt: String,
}

/// `apps/<app_id>.json`. Pinned by hash in the index, so it needs no signature of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppDetail {
    pub format: String,
    pub app_id: String,
    pub description: String,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    pub changelog: Vec<ChangelogEntry>,
    #[serde(default)]
    pub manual: Option<Asset>,
    #[serde(default)]
    pub screenshots: Vec<Screenshot>,
}

// ── Trust ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryTrust {
    /// The signer is an anchor, or holds a valid certificate from one that covers this registry.
    Anchored { publisher: String },
    /// A genuine signature, but nothing ties the signer to an anchor.
    Unanchored { reason: Option<String> },
}

/// The newest accepted file for a registry: its serial and the hash of its exact bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LastSeen {
    pub serial: u64,
    pub sha256: String,
}

pub struct IndexInput<'a> {
    pub index_bytes: &'a [u8],
    pub sig_bytes: &'a [u8],
    pub anchors: &'a [Anchor],
    pub now: i64,
    /// The registry id the user added. The file must carry exactly this id.
    pub expected_id: &'a str,
    pub last_seen: Option<&'a LastSeen>,
}

pub struct RevocationsInput<'a> {
    pub bytes: &'a [u8],
    pub sig_bytes: &'a [u8],
    pub anchors: &'a [Anchor],
    pub now: i64,
    pub expected_id: &'a str,
    pub last_seen: Option<&'a LastSeen>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedIndex {
    pub index: Index,
    /// Key id of the signing key.
    pub signer: String,
    pub trust: RegistryTrust,
    /// Past `expires`. A state, not an error: bytes and signatures are still checked.
    pub stale: bool,
    /// `sha256:` of the exact bytes, to store as [`LastSeen`].
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRevocations {
    pub revocations: Revocations,
    pub signer: String,
    pub trust: RegistryTrust,
    pub stale: bool,
    pub sha256: String,
}

/// `sha256:<hex>` of bytes, the form used throughout the format.
pub fn sha256_of(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

fn parse_json(bytes: &[u8], what: &str) -> Result<Value, RegistryError> {
    // serde_json refuses a byte order mark and invalid UTF-8, as the reference does.
    serde_json::from_slice(bytes).map_err(|e| RegistryError::MalformedJson(format!("{what}: {e}")))
}

fn first_problem(problems: Vec<String>) -> Result<(), RegistryError> {
    match problems.into_iter().next() {
        Some(p) => Err(RegistryError::SchemaInvalid(p)),
        None => Ok(()),
    }
}

/// Parse, check the format string, validate against the schema, and deserialise.
fn parse_checked<T: for<'de> Deserialize<'de>>(
    bytes: &[u8],
    what: &str,
    file: SchemaFile,
    format: &str,
) -> Result<T, RegistryError> {
    let mut doc = parse_json(bytes, what)?;
    let Some(obj) = doc.as_object() else {
        return Err(RegistryError::SchemaInvalid(format!(
            "{what} is not an object"
        )));
    };
    if let Some(f) = obj.get("format").and_then(Value::as_str) {
        if f != format {
            return Err(RegistryError::FormatUnsupported(f.to_string()));
        }
    }
    first_problem(validate(file, &doc))?;
    normalize_integers(&mut doc);
    serde_json::from_value(doc).map_err(|e| RegistryError::SchemaInvalid(e.to_string()))
}

// ── Signatures and trust ──────────────────────────────────────────────────────

fn verify_detached(
    kind: RegistryFile,
    file_bytes: &[u8],
    sig_bytes: &[u8],
) -> Result<RegistrySignature, RegistryError> {
    if sig_bytes.len() > MAX_SIG_BYTES {
        return Err(RegistryError::TooLarge("signature file".into()));
    }
    let doc: Value = serde_json::from_slice(sig_bytes)
        .map_err(|_| RegistryError::SigMalformed("signature file is not JSON".into()))?;
    first_problem(validate(SchemaFile::Sigfile, &doc)).map_err(|e| match e {
        RegistryError::SchemaInvalid(m) => RegistryError::SigMalformed(m),
        other => other,
    })?;
    let sig: RegistrySignature =
        serde_json::from_value(doc).map_err(|e| RegistryError::SigMalformed(e.to_string()))?;
    verify_registry_signature(kind, file_bytes, &sig).map_err(|e| match e {
        VerifyError::BadSignature => RegistryError::BadSignature,
        other => RegistryError::SigMalformed(other.to_string()),
    })?;
    Ok(sig)
}

fn unanchored(reason: &str) -> RegistryTrust {
    RegistryTrust::Unanchored {
        reason: Some(reason.to_string()),
    }
}

/// Is the signer anchored for `subject` (the registry id)? The signer is an anchor, or
/// `chain[0]` is a valid certificate from an anchor naming the signer, with a scope entry
/// that is a prefix of the registry id. Mirrors the bundle rule.
fn trust_of(sig: &RegistrySignature, subject: &str, anchors: &[Anchor], now: i64) -> RegistryTrust {
    if let Some(a) = anchors.iter().find(|a| key_id(&a.key) == sig.keyid) {
        return RegistryTrust::Anchored {
            publisher: a.name.clone(),
        };
    }
    let cert = match sig.chain.as_slice() {
        [] => return RegistryTrust::Unanchored { reason: None },
        [c] => c,
        _ => return unanchored("certificate chains longer than one are not supported"),
    };
    if !anchors.iter().any(|a| key_id(&a.key) == cert.keyid) {
        return unanchored("certificate was not issued by a trusted key");
    }
    let payload = match verify_blob(CERT_DOMAIN, &cert.payload, &cert.sig, &cert.keyid) {
        Ok((payload, _)) => payload,
        Err(VerifyError::BadSignature) => {
            return unanchored("certificate signature does not verify")
        }
        Err(_) => return unanchored("certificate is malformed"),
    };
    // Exactly the certificate fields, with the right types, as in the bundle format.
    let cert: Certificate = match serde_json::from_slice::<Value>(&payload).and_then(|mut v| {
        normalize_integers(&mut v);
        serde_json::from_value(v)
    }) {
        Ok(c) => c,
        Err(_) => return unanchored("certificate is malformed"),
    };
    if cert.schema != STATEMENT_SCHEMA {
        return unanchored("certificate has an unsupported schema");
    }
    if cert.subject != sig.keyid {
        return unanchored("certificate is for a different key");
    }
    if now < cert.not_before {
        return unanchored("certificate is not yet valid");
    }
    if now > cert.not_after {
        return unanchored("certificate has expired");
    }
    if !cert
        .scope
        .iter()
        .any(|p| !p.is_empty() && subject.starts_with(p.as_str()))
    {
        return unanchored("certificate does not cover this registry");
    }
    RegistryTrust::Anchored {
        publisher: cert.name,
    }
}

// ── Rules beyond the schema ───────────────────────────────────────────────────

fn index_problems(index: &Index) -> Vec<String> {
    let mut problems = Vec::new();
    if index.expires <= index.issued_at {
        problems.push("expires must be after issued_at".to_string());
    }
    let mut ids = std::collections::HashSet::new();
    for app in &index.apps {
        if !ids.insert(app.app_id.as_str()) {
            problems.push(format!("duplicate app_id {}", app.app_id));
        }
        let mut versions = std::collections::HashSet::new();
        for v in &app.versions {
            if !versions.insert(v.version.as_str()) {
                problems.push(format!("{}: duplicate version {}", app.app_id, v.version));
            }
            if v.bundle.path != format!("bundles/{}-{}.sanctum", app.app_id, v.version) {
                problems.push(format!(
                    "{} {}: bundle path must be bundles/<app_id>-<version>.sanctum",
                    app.app_id, v.version
                ));
            }
        }
        if !versions.contains(app.latest.as_str()) {
            problems.push(format!(
                "{}: latest {} is not in versions",
                app.app_id, app.latest
            ));
        }
        if app.detail.path != format!("apps/{}.json", app.app_id) {
            problems.push(format!(
                "{}: detail path must be apps/<app_id>.json",
                app.app_id
            ));
        }
    }
    problems
}

fn revocation_problems(doc: &Revocations) -> Vec<String> {
    let mut problems = Vec::new();
    if doc.expires <= doc.issued_at {
        problems.push("expires must be after issued_at".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for e in &doc.entries {
        if !seen.insert(e.checksum.as_str()) {
            problems.push(format!("duplicate checksum {}", e.checksum));
        }
    }
    problems
}

/// Rollback and replay protection. An equal serial is only acceptable for identical bytes.
fn rollback_rule(serial: u64, digest: &str, last: Option<&LastSeen>) -> Result<(), RegistryError> {
    let Some(seen) = last else { return Ok(()) };
    if serial < seen.serial {
        return Err(RegistryError::Rollback {
            got: serial,
            seen: seen.serial,
        });
    }
    if serial == seen.serial && digest != seen.sha256 {
        return Err(RegistryError::SerialReplay);
    }
    Ok(())
}

// ── Top-level checks ──────────────────────────────────────────────────────────

/// Verify a signed `index.json`. Nothing is parsed before the signature checks out.
pub fn verify_index(input: &IndexInput) -> Result<VerifiedIndex, RegistryError> {
    if input.index_bytes.len() > MAX_INDEX_BYTES {
        return Err(RegistryError::TooLarge("index.json".into()));
    }
    let sig = verify_detached(RegistryFile::Index, input.index_bytes, input.sig_bytes)?;
    let index: Index = parse_checked(
        input.index_bytes,
        "index.json",
        SchemaFile::Index,
        INDEX_FORMAT,
    )?;
    first_problem(index_problems(&index))?;
    if index.id != input.expected_id {
        return Err(RegistryError::IdMismatch(index.id));
    }
    if index.issued_at > input.now.saturating_add(SKEW_SECONDS) {
        return Err(RegistryError::FromFuture);
    }
    let digest = sha256_of(input.index_bytes);
    rollback_rule(index.serial, &digest, input.last_seen)?;
    let trust = trust_of(&sig, &index.id, input.anchors, input.now);
    let stale = input.now > index.expires;
    Ok(VerifiedIndex {
        signer: sig.keyid,
        index,
        trust,
        stale,
        sha256: digest,
    })
}

/// Verify a signed `revocations.json`. `registry` must equal the index id.
pub fn verify_revocations(input: &RevocationsInput) -> Result<VerifiedRevocations, RegistryError> {
    if input.bytes.len() > MAX_REVOCATIONS_BYTES {
        return Err(RegistryError::TooLarge("revocations.json".into()));
    }
    let sig = verify_detached(RegistryFile::Revocations, input.bytes, input.sig_bytes)?;
    let doc: Revocations = parse_checked(
        input.bytes,
        "revocations.json",
        SchemaFile::Revocations,
        REVOCATIONS_FORMAT,
    )?;
    first_problem(revocation_problems(&doc))?;
    if doc.registry != input.expected_id {
        return Err(RegistryError::IdMismatch(doc.registry));
    }
    if doc.issued_at > input.now.saturating_add(SKEW_SECONDS) {
        return Err(RegistryError::FromFuture);
    }
    let digest = sha256_of(input.bytes);
    rollback_rule(doc.serial, &digest, input.last_seen)?;
    let trust = trust_of(&sig, &doc.registry, input.anchors, input.now);
    let stale = input.now > doc.expires;
    Ok(VerifiedRevocations {
        signer: sig.keyid,
        revocations: doc,
        trust,
        stale,
        sha256: digest,
    })
}

/// Check bytes fetched for an asset (bundle, image, manual, report) against its index entry.
/// Size first, then hash.
pub fn check_asset(asset: &Asset, bytes: &[u8]) -> Result<(), RegistryError> {
    if bytes.len() as u64 != asset.size {
        return Err(RegistryError::SizeMismatch {
            got: bytes.len(),
            want: asset.size,
        });
    }
    if sha256_of(bytes) != asset.sha256 {
        return Err(RegistryError::HashMismatch(asset.path.clone()));
    }
    Ok(())
}

/// Check an app detail file against its index entry and return it parsed.
pub fn check_detail(entry: &AppEntry, bytes: &[u8]) -> Result<AppDetail, RegistryError> {
    if bytes.len() > MAX_DETAIL_BYTES {
        return Err(RegistryError::TooLarge("app detail".into()));
    }
    check_asset(&entry.detail, bytes)?;
    let detail: AppDetail = parse_checked(bytes, "app detail", SchemaFile::App, APP_FORMAT)?;
    if detail.app_id != entry.app_id {
        return Err(RegistryError::IdMismatch(detail.app_id));
    }
    Ok(detail)
}

/// True if `checksum` (a tool's `sha256:` hash) appears in the revocation list.
pub fn is_revoked(revocations: &Revocations, checksum: &str) -> bool {
    revocations.entries.iter().any(|e| e.checksum == checksum)
}
