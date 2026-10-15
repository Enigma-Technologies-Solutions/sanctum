// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! The registry rules: what it takes to add a registry, what a refresh may change, and what
//! a failure leaves behind.
//!
//! **Adding.** The user gives an address. The client fetches `index.json` and its signature,
//! reads the registry id the file claims (only to know what to check against), then runs the
//! full verification. The id becomes trusted because the signature over it verified. A
//! registry is accepted if its signer is anchored (chains to a key compiled into Sanctum) or
//! the user pinned the signer's key. Otherwise the client refuses and reports the signer's key,
//! so the interface can show it and ask. If the index names a revocation list, that must
//! verify too: a registry whose revocations cannot be read is not added.
//!
//! **Refreshing.** The stored id must match, the serial must not go back, the signer must
//! still be anchored or pinned, and the same serial must mean the same bytes. Any failure
//! changes nothing but a "last error" note, so a bad registry cannot poison a good cached
//! copy. Revocations are the one place a refresh may partly succeed: if the index is fine but
//! the revocations cannot be refreshed, the index updates, the previous revocations stay, and
//! the problem is recorded. (Refusing the new index would let a blocked revocation file freeze
//! a client on an old catalogue.)
//!
//! A registry never grants a capability, and nothing here installs a tool.

use super::fetch::{check_url, fetch, FetchError, Limits, Transport};
use super::store::{
    self, IndexUpdate, RefreshUpdate, StoreError, StoredRegistry, StoredRevocations,
};
use sanctum_bundle::registry::{
    verify_index, verify_revocations, IndexInput, LastSeen, RegistryError, RegistryTrust,
    RevocationsInput, VerifiedIndex, VerifiedRevocations, MAX_INDEX_BYTES, MAX_REVOCATIONS_BYTES,
    MAX_SIG_BYTES,
};
use sanctum_bundle::{parse_key_id, Anchor};
use serde::Serialize;
use sqlx::SqlitePool;
use std::sync::Arc;
use url::Url;

/// How a signer the user pinned is described. Not a publisher name: it says "you decided".
pub const PINNED_NAME: &str = "Key pinned by you";

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum ClientError {
    Fetch(FetchError),
    Verify(RegistryError),
    /// The signature is genuine but the signer is neither anchored nor pinned.
    UntrustedSigner {
        signer: String,
        registry_id: String,
        registry_name: String,
    },
    /// A registry that was anchored or pinned is now signed by a key that is neither.
    SignerChanged {
        signer: String,
    },
    /// The index names a revocation list whose signer is not trusted.
    RevocationsUntrusted,
    BadPinnedKey(String),
    /// The catalogue lists the app but not for installing (a licensed entry in this version).
    NotInstallable(String),
    AppNotFound(String),
    VersionNotFound {
        app_id: String,
        version: String,
    },
    /// The registry's revocation list withdraws this version.
    Revoked {
        app_id: String,
        version: String,
        reason: String,
    },
    /// The signed bundle does not say what the index said it would.
    Inconsistent(String),
    /// The normal bundle checks refused it (signature, undeclared capability, downgrade...).
    BundleRefused(String),
    AlreadyAdded(String),
    AddressInUse(String),
    NotFound,
    Store(StoreError),
}

impl ClientError {
    /// A stable code for the interface to switch on.
    pub fn code(&self) -> &'static str {
        match self {
            ClientError::Fetch(FetchError::Insecure) => "insecure_url",
            ClientError::Fetch(FetchError::InvalidUrl(_)) => "invalid_url",
            ClientError::Fetch(_) => "fetch_failed",
            ClientError::Verify(e) => e.code(),
            ClientError::UntrustedSigner { .. } => "untrusted_signer",
            ClientError::SignerChanged { .. } => "signer_changed",
            ClientError::RevocationsUntrusted => "revocations_untrusted",
            ClientError::BadPinnedKey(_) => "bad_pinned_key",
            ClientError::NotInstallable(_) => "not_installable",
            ClientError::AppNotFound(_) => "app_not_found",
            ClientError::VersionNotFound { .. } => "version_not_found",
            ClientError::Revoked { .. } => "revoked",
            ClientError::Inconsistent(_) => "inconsistent",
            ClientError::BundleRefused(_) => "bundle_refused",
            ClientError::AlreadyAdded(_) => "already_added",
            ClientError::AddressInUse(_) => "address_in_use",
            ClientError::NotFound => "not_found",
            ClientError::Store(_) => "database",
        }
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Fetch(e) => write!(f, "{e}"),
            ClientError::Verify(e) => write!(f, "The registry did not verify: {e}"),
            ClientError::UntrustedSigner { registry_name, .. } => write!(
                f,
                "\"{registry_name}\" is signed by a key Sanctum does not know. Add it only if you trust that key."
            ),
            ClientError::SignerChanged { .. } => write!(
                f,
                "The registry is now signed by a different key than the one you trusted. Nothing was changed."
            ),
            ClientError::RevocationsUntrusted => {
                write!(f, "The registry's revocation list is signed by a key that is not trusted.")
            }
            ClientError::BadPinnedKey(m) => write!(f, "That is not a valid key: {m}"),
            ClientError::NotInstallable(why) => write!(f, "{why}"),
            ClientError::AppNotFound(id) => write!(f, "This registry does not list {id}."),
            ClientError::VersionNotFound { app_id, version } => {
                write!(f, "This registry does not list version {version} of {app_id}.")
            }
            ClientError::Revoked {
                app_id,
                version,
                reason,
            } => write!(
                f,
                "Version {version} of {app_id} was withdrawn by the registry ({reason}), so it will not be installed."
            ),
            ClientError::Inconsistent(what) => write!(
                f,
                "The downloaded bundle does not match what the registry listed ({what}). Nothing was installed."
            ),
            ClientError::BundleRefused(m) => write!(f, "{m}"),
            ClientError::AlreadyAdded(id) => write!(f, "{id} is already added."),
            ClientError::AddressInUse(id) => {
                write!(f, "That address is already used by {id}.")
            }
            ClientError::NotFound => write!(f, "No such registry."),
            ClientError::Store(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<FetchError> for ClientError {
    fn from(e: FetchError) -> Self {
        ClientError::Fetch(e)
    }
}
impl From<RegistryError> for ClientError {
    fn from(e: RegistryError) -> Self {
        ClientError::Verify(e)
    }
}
impl From<StoreError> for ClientError {
    fn from(e: StoreError) -> Self {
        ClientError::Store(e)
    }
}

// ── What the interface sees ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevocationsSummary {
    pub serial: i64,
    pub expires: i64,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySummary {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    /// `anchored` or `pinned`.
    pub trust: String,
    pub publisher: String,
    pub signer: String,
    pub app_count: i64,
    pub serial: i64,
    pub issued_at: i64,
    pub expires: i64,
    /// Past `expires`. Browsing still works; the interface should say so.
    pub stale: bool,
    pub revocations: Option<RevocationsSummary>,
    pub added_at: i64,
    pub last_checked_at: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum IndexOutcome {
    Unchanged,
    #[serde(rename_all = "camelCase")]
    Updated {
        from_serial: i64,
        to_serial: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RevocationsOutcome {
    /// The index does not list a revocation list.
    NotListed,
    Unchanged,
    Updated,
    /// The index was refreshed but the revocations were not; the previous ones are kept.
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshReport {
    pub index: IndexOutcome,
    pub revocations: RevocationsOutcome,
    pub registry: RegistrySummary,
}

/// A cached registry after verifying its stored bytes again.
#[derive(Debug)]
pub struct Cached {
    pub index: VerifiedIndex,
    pub revocations: Option<VerifiedRevocations>,
}

// ── Client ────────────────────────────────────────────────────────────────────

pub struct RegistryClient {
    pub(super) pool: SqlitePool,
    pub(super) transport: Arc<dyn Transport>,
    pub(super) anchors: Vec<Anchor>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

fn system_clock() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A base URL ends in `/` so file names resolve inside it.
pub(super) fn normalize_base(raw: &str) -> Result<Url, FetchError> {
    let mut url = check_url(raw, false)?;
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// `relative` resolved inside `base`. The result must stay under it.
pub(super) fn resolve(base: &Url, relative: &str) -> Result<Url, FetchError> {
    let url = base
        .join(relative)
        .map_err(|e| FetchError::InvalidUrl(e.to_string()))?;
    if !url.as_str().starts_with(base.as_str()) {
        return Err(FetchError::InvalidUrl(format!(
            "{relative} leaves the registry"
        )));
    }
    Ok(url)
}

struct Classified {
    trust: &'static str,
    publisher: String,
    pinned_key: Option<String>,
}

impl RegistryClient {
    pub fn new(
        pool: SqlitePool,
        transport: Arc<dyn Transport>,
        anchors: Vec<Anchor>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> RegistryClient {
        RegistryClient {
            pool,
            transport,
            anchors,
            clock,
        }
    }

    /// The real client: system clock, the anchors compiled into this build, real HTTPS.
    pub fn production(pool: SqlitePool) -> Result<RegistryClient, String> {
        let transport = super::fetch::ReqwestTransport::new()?;
        Ok(RegistryClient::new(
            pool,
            Arc::new(transport),
            crate::trust::production_anchors(),
            Arc::new(system_clock),
        ))
    }

    pub(super) fn now(&self) -> i64 {
        (self.clock)()
    }

    fn anchors_with(&self, pinned: Option<&str>) -> Result<Vec<Anchor>, ClientError> {
        let mut anchors = self.anchors.clone();
        if let Some(id) = pinned {
            let key = parse_key_id(id).map_err(ClientError::BadPinnedKey)?;
            anchors.push(Anchor {
                key,
                name: PINNED_NAME.to_string(),
            });
        }
        Ok(anchors)
    }

    /// Anchored (compiled-in key), pinned (the key the user gave), or neither.
    fn classify(trust: &RegistryTrust, signer: &str, pinned: Option<&str>) -> Option<Classified> {
        match trust {
            RegistryTrust::Anchored { publisher }
                if publisher == PINNED_NAME && pinned == Some(signer) =>
            {
                Some(Classified {
                    trust: "pinned",
                    publisher: PINNED_NAME.to_string(),
                    pinned_key: Some(signer.to_string()),
                })
            }
            RegistryTrust::Anchored { publisher } => Some(Classified {
                trust: "anchored",
                publisher: publisher.clone(),
                pinned_key: None,
            }),
            RegistryTrust::Unanchored { .. } => None,
        }
    }

    async fn fetch_signed(
        &self,
        base: &Url,
        file: &str,
        max: usize,
    ) -> Result<(Vec<u8>, Vec<u8>), ClientError> {
        let url = resolve(base, file)?;
        let sig_url = resolve(base, &format!("{file}.sig"))?;
        let bytes = fetch(&*self.transport, &url, Limits::new(max)).await?;
        let sig = fetch(&*self.transport, &sig_url, Limits::new(MAX_SIG_BYTES)).await?;
        Ok((bytes, sig))
    }

    /// Fetch and verify the revocation list the index names. Returns what to store.
    async fn fetch_revocations(
        &self,
        base: &Url,
        path: &str,
        registry_id: &str,
        anchors: &[Anchor],
        pinned: Option<&str>,
        last_seen: Option<&LastSeen>,
    ) -> Result<(VerifiedRevocations, StoredRevocations), ClientError> {
        let (bytes, sig) = self.fetch_signed(base, path, MAX_REVOCATIONS_BYTES).await?;
        let verified = verify_revocations(&RevocationsInput {
            bytes: &bytes,
            sig_bytes: &sig,
            anchors,
            now: self.now(),
            expected_id: registry_id,
            last_seen,
        })?;
        if Self::classify(&verified.trust, &verified.signer, pinned).is_none() {
            return Err(ClientError::RevocationsUntrusted);
        }
        let stored = StoredRevocations {
            serial: verified.revocations.serial as i64,
            sha256: verified.sha256.clone(),
            expires: verified.revocations.expires,
            fetched_at: self.now(),
            json: bytes,
            sig,
        };
        Ok((verified, stored))
    }

    // ── Operations ────────────────────────────────────────────────────────────

    /// Add a registry. `pinned_key` is a signer key the user chose to trust, for registries
    /// that are not anchored.
    pub async fn add(
        &self,
        base_url: &str,
        pinned_key: Option<&str>,
    ) -> Result<RegistrySummary, ClientError> {
        let base = normalize_base(base_url)?;
        let anchors = self.anchors_with(pinned_key)?;

        let (index_bytes, index_sig) = self
            .fetch_signed(&base, "index.json", MAX_INDEX_BYTES)
            .await?;
        // The id is read before verification only to know what to verify against. It is
        // trusted because the signature below covers it.
        let claimed_id = serde_json::from_slice::<serde_json::Value>(&index_bytes)
            .ok()
            .and_then(|v| v.get("id").and_then(|i| i.as_str().map(str::to_string)))
            .ok_or_else(|| {
                RegistryError::SchemaInvalid("index.json has no registry id".to_string())
            })?;
        let verified = verify_index(&IndexInput {
            index_bytes: &index_bytes,
            sig_bytes: &index_sig,
            anchors: &anchors,
            now: self.now(),
            expected_id: &claimed_id,
            last_seen: None,
        })?;
        let class =
            Self::classify(&verified.trust, &verified.signer, pinned_key).ok_or_else(|| {
                ClientError::UntrustedSigner {
                    signer: verified.signer.clone(),
                    registry_id: verified.index.id.clone(),
                    registry_name: verified.index.name.clone(),
                }
            })?;

        if store::get(&self.pool, &verified.index.id).await?.is_some() {
            return Err(ClientError::AlreadyAdded(verified.index.id.clone()));
        }
        if let Some(other) = store::find_by_url(&self.pool, base.as_str()).await? {
            return Err(ClientError::AddressInUse(other.id));
        }

        let revocations = match &verified.index.revocations {
            Some(path) => Some(
                self.fetch_revocations(&base, path, &verified.index.id, &anchors, pinned_key, None)
                    .await?
                    .1,
            ),
            None => None,
        };

        let now = self.now();
        let row = StoredRegistry {
            id: verified.index.id.clone(),
            base_url: base.to_string(),
            name: verified.index.name.clone(),
            kind: kind_str(&verified),
            trust: class.trust.to_string(),
            pinned_key: class.pinned_key,
            publisher: class.publisher,
            signer: verified.signer.clone(),
            app_count: verified.index.apps.len() as i64,
            added_at: now,
            last_checked_at: Some(now),
            last_error: None,
            index_json: index_bytes,
            index_sig,
            index_serial: verified.index.serial as i64,
            index_sha256: verified.sha256.clone(),
            index_issued_at: verified.index.issued_at,
            index_expires: verified.index.expires,
            index_fetched_at: now,
            revocations,
        };
        store::insert(&self.pool, &row).await?;
        Ok(self.summarize(&row))
    }

    /// Refresh a registry. Any failure leaves the cached copy exactly as it was.
    pub async fn refresh(&self, id: &str) -> Result<RefreshReport, ClientError> {
        let row = store::get(&self.pool, id)
            .await?
            .ok_or(ClientError::NotFound)?;
        match self.refresh_inner(&row).await {
            Ok(report) => Ok(report),
            Err(e) => {
                // A failure to even record the failure must not hide the real error.
                let _ = store::record_failure(&self.pool, id, self.now(), &e.to_string()).await;
                Err(e)
            }
        }
    }

    async fn refresh_inner(&self, row: &StoredRegistry) -> Result<RefreshReport, ClientError> {
        let base = normalize_base(&row.base_url)?;
        let pinned = row.pinned_key.as_deref();
        let anchors = self.anchors_with(pinned)?;
        let seen = LastSeen {
            serial: row.index_serial as u64,
            sha256: row.index_sha256.clone(),
        };

        let (index_bytes, index_sig) = self
            .fetch_signed(&base, "index.json", MAX_INDEX_BYTES)
            .await?;
        let verified = verify_index(&IndexInput {
            index_bytes: &index_bytes,
            sig_bytes: &index_sig,
            anchors: &anchors,
            now: self.now(),
            expected_id: &row.id,
            last_seen: Some(&seen),
        })?;
        let class = Self::classify(&verified.trust, &verified.signer, pinned).ok_or_else(|| {
            ClientError::SignerChanged {
                signer: verified.signer.clone(),
            }
        })?;

        let new_serial = verified.index.serial as i64;
        // A new signature over the same bytes (say the user's pin became a real anchor) is
        // still worth recording.
        let unchanged = verified.sha256 == row.index_sha256 && verified.signer == row.signer;

        // Revocations are handled on their own: a failure here must not block the index.
        let old_rev = row.revocations.as_ref().map(|r| LastSeen {
            serial: r.serial as u64,
            sha256: r.sha256.clone(),
        });
        let mut new_rev: Option<StoredRevocations> = None;
        let rev_outcome = match &verified.index.revocations {
            None => RevocationsOutcome::NotListed,
            Some(path) => match self
                .fetch_revocations(&base, path, &row.id, &anchors, pinned, old_rev.as_ref())
                .await
            {
                Ok((v, stored)) => {
                    if row.revocations.as_ref().map(|r| r.sha256.as_str())
                        == Some(v.sha256.as_str())
                    {
                        RevocationsOutcome::Unchanged
                    } else {
                        new_rev = Some(stored);
                        RevocationsOutcome::Updated
                    }
                }
                Err(e) => RevocationsOutcome::Failed {
                    message: format!("Revocations were not refreshed: {e}"),
                },
            },
        };
        let note = match &rev_outcome {
            RevocationsOutcome::Failed { message } => Some(message.as_str()),
            _ => None,
        };

        let now = self.now();
        let index_update = if unchanged {
            // Same bytes: nothing to rewrite, but a signer upgrade (pinned to anchored) or a
            // fresh certificate does not change the file, so there is nothing else to store.
            None
        } else {
            Some(IndexUpdate {
                name: &verified.index.name,
                kind: kind_label(&verified),
                trust: class.trust,
                pinned_key: class.pinned_key.as_deref(),
                publisher: &class.publisher,
                signer: &verified.signer,
                app_count: verified.index.apps.len() as i64,
                json: &index_bytes,
                sig: &index_sig,
                serial: new_serial,
                sha256: &verified.sha256,
                issued_at: verified.index.issued_at,
                expires: verified.index.expires,
                fetched_at: now,
            })
        };
        store::save_refresh(
            &self.pool,
            &row.id,
            &RefreshUpdate {
                checked_at: now,
                last_error: note,
                index: index_update,
                revocations: new_rev.as_ref(),
            },
        )
        .await?;

        let fresh = store::get(&self.pool, &row.id)
            .await?
            .ok_or(ClientError::NotFound)?;
        Ok(RefreshReport {
            index: if unchanged {
                IndexOutcome::Unchanged
            } else {
                IndexOutcome::Updated {
                    from_serial: row.index_serial,
                    to_serial: new_serial,
                }
            },
            revocations: rev_outcome,
            registry: self.summarize(&fresh),
        })
    }

    pub async fn remove(&self, id: &str) -> Result<(), ClientError> {
        if store::delete(&self.pool, id).await? {
            Ok(())
        } else {
            Err(ClientError::NotFound)
        }
    }

    pub async fn list(&self) -> Result<Vec<RegistrySummary>, ClientError> {
        Ok(store::list(&self.pool)
            .await?
            .iter()
            .map(|r| self.summarize(r))
            .collect())
    }

    pub async fn get(&self, id: &str) -> Result<RegistrySummary, ClientError> {
        let row = store::get(&self.pool, id)
            .await?
            .ok_or(ClientError::NotFound)?;
        Ok(self.summarize(&row))
    }

    /// The cached catalogue, verified again from its stored bytes. The database is not a
    /// trusted source: a modified row fails here, whatever the table says.
    pub async fn cached(&self, id: &str) -> Result<Cached, ClientError> {
        let row = store::get(&self.pool, id)
            .await?
            .ok_or(ClientError::NotFound)?;
        let pinned = row.pinned_key.as_deref();
        let anchors = self.anchors_with(pinned)?;
        let index = verify_index(&IndexInput {
            index_bytes: &row.index_json,
            sig_bytes: &row.index_sig,
            anchors: &anchors,
            now: self.now(),
            expected_id: &row.id,
            last_seen: None,
        })?;
        if Self::classify(&index.trust, &index.signer, pinned).is_none() {
            return Err(ClientError::SignerChanged {
                signer: index.signer.clone(),
            });
        }
        let revocations = match &row.revocations {
            Some(r) => {
                let v = verify_revocations(&RevocationsInput {
                    bytes: &r.json,
                    sig_bytes: &r.sig,
                    anchors: &anchors,
                    now: self.now(),
                    expected_id: &row.id,
                    last_seen: None,
                })?;
                if Self::classify(&v.trust, &v.signer, pinned).is_none() {
                    return Err(ClientError::RevocationsUntrusted);
                }
                Some(v)
            }
            None => None,
        };
        Ok(Cached { index, revocations })
    }

    fn summarize(&self, r: &StoredRegistry) -> RegistrySummary {
        let now = self.now();
        RegistrySummary {
            id: r.id.clone(),
            name: r.name.clone(),
            kind: r.kind.clone(),
            base_url: r.base_url.clone(),
            trust: r.trust.clone(),
            publisher: r.publisher.clone(),
            signer: r.signer.clone(),
            app_count: r.app_count,
            serial: r.index_serial,
            issued_at: r.index_issued_at,
            expires: r.index_expires,
            stale: now > r.index_expires,
            revocations: r.revocations.as_ref().map(|v| RevocationsSummary {
                serial: v.serial,
                expires: v.expires,
                stale: now > v.expires,
            }),
            added_at: r.added_at,
            last_checked_at: r.last_checked_at,
            last_error: r.last_error.clone(),
        }
    }
}

fn kind_label(v: &VerifiedIndex) -> &'static str {
    match v.index.kind {
        sanctum_bundle::registry::Kind::Public => "public",
        sanctum_bundle::registry::Kind::Licensed => "licensed",
    }
}

fn kind_str(v: &VerifiedIndex) -> String {
    kind_label(v).to_string()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::fetch::testing::{Mock, Script};
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;
    use sanctum_bundle::{
        issue_certificate, key_id, sign_registry_file, Certificate, RegistryFile,
    };
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicI64, Ordering};

    /// A scripted server state for a test case.
    type Setup = Box<dyn Fn(&Env)>;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 86_400;
    const BASE: &str = "https://registry.test/v1/";
    const ID: &str = "registry:sh.test.public";

    struct Reg {
        id: &'static str,
        serial: u64,
        apps: usize,
        revocations: bool,
        kind: &'static str,
    }

    impl Default for Reg {
        fn default() -> Reg {
            Reg {
                id: ID,
                serial: 7,
                apps: 2,
                revocations: true,
                kind: "public",
            }
        }
    }

    fn hash(s: &str) -> String {
        sanctum_bundle::registry::sha256_of(s.as_bytes())
    }

    fn app(name: &str, key: &SigningKey) -> Value {
        json!({
            "app_id": format!("sh.test.{name}"),
            "name": name,
            "summary": "s",
            "publisher": { "keyid": key_id(&key.verifying_key()), "name": "P" },
            "access": "free",
            "latest": "1.0.0",
            "detail": { "path": format!("apps/sh.test.{name}.json"), "sha256": hash(name), "size": 10 },
            "versions": [{
                "version": "1.0.0",
                "published_at": NOW - 5000,
                "bundle": { "path": format!("bundles/sh.test.{name}-1.0.0.sanctum"), "sha256": hash(name), "size": 10 },
                "checksum": hash(name),
                "declared": []
            }]
        })
    }

    fn index(r: &Reg, key: &SigningKey) -> Vec<u8> {
        let apps: Vec<Value> = (0..r.apps).map(|i| app(&format!("app{i}"), key)).collect();
        let mut doc = json!({
            "format": "sanctum-registry/1",
            "id": r.id,
            "name": "Test Registry",
            "kind": r.kind,
            "serial": r.serial,
            "issued_at": NOW - 1000,
            "expires": NOW + 90 * DAY,
            "apps": apps
        });
        if r.revocations {
            doc["revocations"] = json!("revocations.json");
        }
        serde_json::to_vec_pretty(&doc).unwrap()
    }

    fn revocations(id: &str, serial: u64) -> Vec<u8> {
        serde_json::to_vec_pretty(&json!({
            "format": "sanctum-registry-revocations/1",
            "registry": id,
            "serial": serial,
            "issued_at": NOW - 500,
            "expires": NOW + 14 * DAY,
            "entries": []
        }))
        .unwrap()
    }

    fn sig(kind: RegistryFile, bytes: &[u8], key: &SigningKey) -> Vec<u8> {
        serde_json::to_vec_pretty(&sign_registry_file(kind, bytes, key, None)).unwrap()
    }

    fn url(file: &str) -> String {
        format!("{BASE}{file}")
    }

    struct Env {
        client: RegistryClient,
        mock: Arc<Mock>,
        root: SigningKey,
        other: SigningKey,
        pool: SqlitePool,
        clock: Arc<AtomicI64>,
    }

    impl Env {
        async fn new() -> Env {
            let dir = std::env::temp_dir()
                .join(format!("sanctum-registry-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let pool = crate::db::create_pool(&dir).await.unwrap();
            crate::db::run_migrations(&pool).await.unwrap();
            let root = SigningKey::generate(&mut OsRng);
            let other = SigningKey::generate(&mut OsRng);
            let mock = Arc::new(Mock::new());
            let clock = Arc::new(AtomicI64::new(NOW));
            let c = clock.clone();
            let client = RegistryClient::new(
                pool.clone(),
                mock.clone(),
                vec![Anchor {
                    key: root.verifying_key(),
                    name: "Test Root".into(),
                }],
                Arc::new(move || c.load(Ordering::SeqCst)),
            );
            Env {
                client,
                mock,
                root,
                other,
                pool,
                clock,
            }
        }

        fn publish_index(&self, r: &Reg, signer: &SigningKey) {
            let bytes = index(r, signer);
            self.mock.serve(&url("index.json"), &bytes);
            self.mock.serve(
                &url("index.json.sig"),
                &sig(RegistryFile::Index, &bytes, signer),
            );
        }

        fn publish_revocations(&self, id: &str, serial: u64, signer: &SigningKey) {
            let bytes = revocations(id, serial);
            self.mock.serve(&url("revocations.json"), &bytes);
            self.mock.serve(
                &url("revocations.json.sig"),
                &sig(RegistryFile::Revocations, &bytes, signer),
            );
        }

        /// A complete anchored registry at the default address.
        fn publish(&self, r: &Reg) {
            self.publish_index(r, &self.root);
            if r.revocations {
                self.publish_revocations(r.id, 3, &self.root);
            }
        }

        async fn row(&self) -> StoredRegistry {
            store::get(&self.pool, ID)
                .await
                .unwrap()
                .expect("registry stored")
        }

        async fn count(&self) -> usize {
            store::list(&self.pool).await.unwrap().len()
        }
    }

    /// Everything a refresh is allowed to change only when it succeeds.
    fn cache_view(
        r: &StoredRegistry,
    ) -> (
        Vec<u8>,
        Vec<u8>,
        i64,
        String,
        Option<StoredRevocations>,
        String,
    ) {
        (
            r.index_json.clone(),
            r.index_sig.clone(),
            r.index_serial,
            r.index_sha256.clone(),
            r.revocations.clone(),
            r.trust.clone(),
        )
    }

    #[test]
    fn files_resolve_only_inside_the_registry() {
        let base = normalize_base(BASE).unwrap();
        assert_eq!(
            resolve(&base, "index.json").unwrap().as_str(),
            url("index.json")
        );
        assert_eq!(
            resolve(&base, "apps/a.b.json").unwrap().as_str(),
            url("apps/a.b.json")
        );
        for bad in [
            "../other/index.json",
            "/index.json",
            "https://evil.test/v1/index.json",
            "//evil.test/v1/index.json",
            "http://registry.test/v1/index.json",
        ] {
            assert!(resolve(&base, bad).is_err(), "{bad} escaped the registry");
        }
    }

    // ── Adding ────────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn adding_an_anchored_registry_stores_it_with_its_cache() {
        let e = Env::new().await;
        e.publish(&Reg::default());
        let s = e.client.add(BASE, None).await.unwrap();
        assert_eq!(s.id, ID);
        assert_eq!(s.trust, "anchored");
        assert_eq!(s.publisher, "Test Root");
        assert_eq!(s.app_count, 2);
        assert_eq!(s.serial, 7);
        assert_eq!(s.kind, "public");
        assert!(!s.stale);
        assert_eq!(s.revocations.as_ref().unwrap().serial, 3);
        assert_eq!(s.last_error, None);
        let row = e.row().await;
        assert_eq!(row.base_url, BASE);
        assert!(row.pinned_key.is_none());
        assert_eq!(e.client.list().await.unwrap(), vec![s]);
    }

    #[tokio::test]
    async fn the_address_is_normalised_to_a_directory() {
        let e = Env::new().await;
        e.publish(&Reg::default());
        let s = e
            .client
            .add("  https://registry.test/v1  ", None)
            .await
            .unwrap();
        assert_eq!(s.base_url, BASE);
    }

    #[tokio::test]
    async fn plain_http_and_odd_addresses_are_refused_with_no_request() {
        let e = Env::new().await;
        e.publish(&Reg::default());
        for bad in [
            "http://registry.test/v1/",
            "https://user:pw@registry.test/v1/",
            "https://registry.test/v1/?x=1",
            "https://registry.test/v1/#x",
            "file:///tmp/registry/",
            "registry.test/v1/",
            "",
        ] {
            let err = e.client.add(bad, None).await.unwrap_err();
            assert!(
                matches!(err.code(), "insecure_url" | "invalid_url"),
                "{bad}: {}",
                err.code()
            );
        }
        assert_eq!(e.mock.call_count(), 0);
        assert_eq!(e.count().await, 0);
    }

    #[tokio::test]
    async fn a_registry_signed_by_an_unknown_key_needs_the_user_to_pin_it() {
        let e = Env::new().await;
        e.publish_index(
            &Reg {
                revocations: false,
                ..Reg::default()
            },
            &e.other,
        );

        // First attempt: refused, and the error carries what the interface must show.
        let err = e.client.add(BASE, None).await.unwrap_err();
        match &err {
            ClientError::UntrustedSigner {
                signer,
                registry_id,
                registry_name,
            } => {
                assert_eq!(signer, &key_id(&e.other.verifying_key()));
                assert_eq!(registry_id, ID);
                assert_eq!(registry_name, "Test Registry");
            }
            other => panic!("expected UntrustedSigner, got {other:?}"),
        }
        assert_eq!(err.code(), "untrusted_signer");
        assert_eq!(e.count().await, 0, "nothing is stored until the user pins");

        // Pinning a different key does not help.
        let stranger = key_id(&SigningKey::generate(&mut OsRng).verifying_key());
        assert_eq!(
            e.client
                .add(BASE, Some(&stranger))
                .await
                .unwrap_err()
                .code(),
            "untrusted_signer"
        );

        // Pinning the signer's key does.
        let pin = key_id(&e.other.verifying_key());
        let s = e.client.add(BASE, Some(&pin)).await.unwrap();
        assert_eq!(s.trust, "pinned");
        assert_eq!(s.publisher, PINNED_NAME);
        assert_eq!(e.row().await.pinned_key.as_deref(), Some(pin.as_str()));
    }

    #[tokio::test]
    async fn a_malformed_pinned_key_is_rejected_before_any_request() {
        let e = Env::new().await;
        e.publish(&Reg::default());
        let err = e.client.add(BASE, Some("ed25519:nope")).await.unwrap_err();
        assert_eq!(err.code(), "bad_pinned_key");
        assert_eq!(e.mock.call_count(), 0);
    }

    #[tokio::test]
    async fn a_pin_is_ignored_when_the_registry_is_anchored_anyway() {
        let e = Env::new().await;
        e.publish(&Reg::default());
        let pin = key_id(&e.other.verifying_key());
        let s = e.client.add(BASE, Some(&pin)).await.unwrap();
        assert_eq!(s.trust, "anchored");
        assert!(e.row().await.pinned_key.is_none());
    }

    #[tokio::test]
    async fn a_chain_to_the_anchor_is_enough_without_a_pin() {
        let e = Env::new().await;
        let registry_key = SigningKey::generate(&mut OsRng);
        let cert = issue_certificate(
            &e.root,
            &Certificate {
                schema: 1,
                subject: key_id(&registry_key.verifying_key()),
                name: "Test Publisher".into(),
                not_before: NOW - 100_000,
                not_after: NOW + 100_000_000,
                scope: vec!["registry:sh.test.".into()],
            },
        )
        .unwrap();
        let bytes = index(
            &Reg {
                revocations: false,
                ..Reg::default()
            },
            &registry_key,
        );
        e.mock.serve(&url("index.json"), &bytes);
        let signature = sign_registry_file(RegistryFile::Index, &bytes, &registry_key, Some(cert));
        e.mock.serve(
            &url("index.json.sig"),
            &serde_json::to_vec(&signature).unwrap(),
        );
        let s = e.client.add(BASE, None).await.unwrap();
        assert_eq!(s.trust, "anchored");
        assert_eq!(s.publisher, "Test Publisher");
    }

    #[tokio::test]
    async fn anything_that_fails_verification_stores_nothing() {
        // Each case serves something wrong; none may leave a row behind.
        let cases: Vec<(&str, Setup)> = vec![
            (
                "missing signature",
                Box::new(|e| {
                    e.publish(&Reg::default());
                    e.mock.route(&url("index.json.sig"), Script::Status(404));
                }),
            ),
            (
                "tampered index",
                Box::new(|e| {
                    e.publish(&Reg::default());
                    let mut bytes = index(&Reg::default(), &e.root);
                    bytes.push(b' ');
                    e.mock.serve(&url("index.json"), &bytes);
                }),
            ),
            (
                "garbage signature",
                Box::new(|e| {
                    e.publish(&Reg::default());
                    e.mock.serve(&url("index.json.sig"), b"not json");
                }),
            ),
            (
                "not json at all",
                Box::new(|e| {
                    let junk = b"<html>hi</html>".to_vec();
                    e.mock.serve(&url("index.json"), &junk);
                    e.mock.serve(
                        &url("index.json.sig"),
                        &sig(RegistryFile::Index, &junk, &e.root),
                    );
                }),
            ),
            (
                "no id",
                Box::new(|e| {
                    let bytes = br#"{"format":"sanctum-registry/1"}"#.to_vec();
                    e.mock.serve(&url("index.json"), &bytes);
                    e.mock.serve(
                        &url("index.json.sig"),
                        &sig(RegistryFile::Index, &bytes, &e.root),
                    );
                }),
            ),
            (
                "server down",
                Box::new(|e| {
                    e.mock
                        .route(&url("index.json"), Script::Down("refused".into()));
                }),
            ),
            (
                "oversize index",
                Box::new(|e| {
                    e.mock
                        .serve(&url("index.json"), &vec![b' '; 2 * 1024 * 1024 + 1]);
                }),
            ),
            (
                "revocations missing",
                Box::new(|e| {
                    e.publish_index(&Reg::default(), &e.root);
                }),
            ),
            (
                "revocations tampered",
                Box::new(|e| {
                    e.publish(&Reg::default());
                    let mut b = revocations(ID, 3);
                    b.push(b' ');
                    e.mock.serve(&url("revocations.json"), &b);
                }),
            ),
            (
                "revocations for another registry",
                Box::new(|e| {
                    e.publish_index(&Reg::default(), &e.root);
                    e.publish_revocations("registry:sh.test.other", 3, &e.root);
                }),
            ),
            (
                "revocations signed by an unknown key",
                Box::new(|e| {
                    e.publish_index(&Reg::default(), &e.root);
                    e.publish_revocations(ID, 3, &e.other);
                }),
            ),
        ];
        for (name, setup) in cases {
            let e = Env::new().await;
            setup(&e);
            assert!(
                e.client.add(BASE, None).await.is_err(),
                "{name} was accepted"
            );
            assert_eq!(e.count().await, 0, "{name} left a row behind");
        }
    }

    #[tokio::test]
    async fn revocations_signed_by_an_unknown_key_report_the_right_code() {
        let e = Env::new().await;
        e.publish_index(&Reg::default(), &e.root);
        e.publish_revocations(ID, 3, &e.other);
        assert_eq!(
            e.client.add(BASE, None).await.unwrap_err().code(),
            "revocations_untrusted"
        );
    }

    #[tokio::test]
    async fn a_registry_without_a_revocation_list_can_be_added() {
        let e = Env::new().await;
        e.publish(&Reg {
            revocations: false,
            ..Reg::default()
        });
        let s = e.client.add(BASE, None).await.unwrap();
        assert!(s.revocations.is_none());
    }

    #[tokio::test]
    async fn the_same_registry_cannot_be_added_twice_and_an_address_has_one_owner() {
        let e = Env::new().await;
        e.publish(&Reg::default());
        e.client.add(BASE, None).await.unwrap();
        assert_eq!(
            e.client.add(BASE, None).await.unwrap_err().code(),
            "already_added"
        );

        // The server now answers with a different registry at the same address.
        e.publish(&Reg {
            id: "registry:sh.test.other",
            ..Reg::default()
        });
        e.publish_revocations("registry:sh.test.other", 3, &e.root);
        assert_eq!(
            e.client.add(BASE, None).await.unwrap_err().code(),
            "address_in_use"
        );
        assert_eq!(e.count().await, 1);
    }

    #[tokio::test]
    async fn a_licensed_registry_is_stored_as_licensed() {
        let e = Env::new().await;
        e.publish(&Reg {
            kind: "licensed",
            ..Reg::default()
        });
        assert_eq!(e.client.add(BASE, None).await.unwrap().kind, "licensed");
    }

    // ── Refreshing ────────────────────────────────────────────────────────────

    async fn added() -> Env {
        let e = Env::new().await;
        e.publish(&Reg::default());
        e.client.add(BASE, None).await.unwrap();
        e
    }

    #[tokio::test]
    async fn a_newer_index_replaces_the_cache() {
        let e = added().await;
        e.clock.store(NOW + DAY, Ordering::SeqCst);
        e.publish(&Reg {
            serial: 8,
            apps: 3,
            ..Reg::default()
        });
        e.publish_revocations(ID, 4, &e.root);
        let r = e.client.refresh(ID).await.unwrap();
        assert_eq!(
            r.index,
            IndexOutcome::Updated {
                from_serial: 7,
                to_serial: 8
            }
        );
        assert_eq!(r.revocations, RevocationsOutcome::Updated);
        assert_eq!(r.registry.serial, 8);
        assert_eq!(r.registry.app_count, 3);
        assert_eq!(r.registry.revocations.as_ref().unwrap().serial, 4);
        assert_eq!(r.registry.last_error, None);
        assert_eq!(r.registry.last_checked_at, Some(NOW + DAY));
        // The stored bytes are the new ones.
        let c = e.client.cached(ID).await.unwrap();
        assert_eq!(c.index.index.serial, 8);
        assert_eq!(c.revocations.unwrap().revocations.serial, 4);
    }

    #[tokio::test]
    async fn refreshing_unchanged_files_only_moves_the_check_time() {
        let e = added().await;
        let before = cache_view(&e.row().await);
        e.clock.store(NOW + 3600, Ordering::SeqCst);
        let r = e.client.refresh(ID).await.unwrap();
        assert_eq!(r.index, IndexOutcome::Unchanged);
        assert_eq!(r.revocations, RevocationsOutcome::Unchanged);
        assert_eq!(cache_view(&e.row().await), before);
        assert_eq!(e.row().await.last_checked_at, Some(NOW + 3600));
    }

    #[tokio::test]
    async fn every_bad_refresh_leaves_the_good_cache_untouched() {
        let cases: Vec<(&str, &str, Setup)> = vec![
            (
                "rollback",
                "rollback",
                Box::new(|e| {
                    e.publish_index(
                        &Reg {
                            serial: 6,
                            ..Reg::default()
                        },
                        &e.root,
                    );
                }),
            ),
            (
                "same serial, different contents",
                "serial_replay",
                Box::new(|e| {
                    e.publish_index(
                        &Reg {
                            apps: 5,
                            ..Reg::default()
                        },
                        &e.root,
                    );
                }),
            ),
            (
                "tampered",
                "bad_signature",
                Box::new(|e| {
                    let mut bytes = index(
                        &Reg {
                            serial: 9,
                            ..Reg::default()
                        },
                        &e.root,
                    );
                    let sg = sig(RegistryFile::Index, &bytes, &e.root);
                    bytes.push(b' ');
                    e.mock.serve(&url("index.json"), &bytes);
                    e.mock.serve(&url("index.json.sig"), &sg);
                }),
            ),
            (
                "another registry's id",
                "id_mismatch",
                Box::new(|e| {
                    e.publish_index(
                        &Reg {
                            id: "registry:sh.test.other",
                            serial: 9,
                            ..Reg::default()
                        },
                        &e.root,
                    );
                }),
            ),
            (
                "now signed by an unknown key",
                "signer_changed",
                Box::new(|e| {
                    e.publish_index(
                        &Reg {
                            serial: 9,
                            ..Reg::default()
                        },
                        &e.other,
                    );
                }),
            ),
            (
                "not json",
                "malformed_json",
                Box::new(|e| {
                    let junk = b"<html>maintenance</html>".to_vec();
                    e.mock.serve(&url("index.json"), &junk);
                    e.mock.serve(
                        &url("index.json.sig"),
                        &sig(RegistryFile::Index, &junk, &e.root),
                    );
                }),
            ),
            (
                "server error",
                "fetch_failed",
                Box::new(|e| {
                    e.mock.route(&url("index.json"), Script::Status(503));
                }),
            ),
            (
                "server gone",
                "fetch_failed",
                Box::new(|e| {
                    e.mock
                        .route(&url("index.json"), Script::Down("unreachable".into()));
                }),
            ),
            (
                "redirect to another host",
                "fetch_failed",
                Box::new(|e| {
                    e.mock.route(
                        &url("index.json"),
                        Script::Redirect(302, "https://evil.test/index.json".into()),
                    );
                }),
            ),
            (
                "oversize",
                "fetch_failed",
                Box::new(|e| {
                    e.mock
                        .serve(&url("index.json"), &vec![b' '; 2 * 1024 * 1024 + 1]);
                }),
            ),
        ];
        for (name, code, setup) in cases {
            let e = added().await;
            let before = cache_view(&e.row().await);
            e.clock.store(NOW + 7200, Ordering::SeqCst);
            setup(&e);
            let err = e.client.refresh(ID).await.unwrap_err();
            assert_eq!(err.code(), code, "{name}");
            let after = e.row().await;
            assert_eq!(cache_view(&after), before, "{name} changed the cache");
            // The failure is recorded for the interface, and nothing else moves.
            assert_eq!(after.last_checked_at, Some(NOW + 7200), "{name}");
            assert!(after.last_error.is_some(), "{name} left no note");
            // And the cache still verifies and serves.
            assert_eq!(
                e.client.cached(ID).await.unwrap().index.index.serial,
                7,
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn a_good_refresh_clears_the_previous_error() {
        let e = added().await;
        e.mock.route(&url("index.json"), Script::Status(500));
        assert!(e.client.refresh(ID).await.is_err());
        assert!(e.row().await.last_error.is_some());
        e.publish(&Reg {
            serial: 8,
            ..Reg::default()
        });
        e.client.refresh(ID).await.unwrap();
        assert_eq!(e.row().await.last_error, None);
    }

    #[tokio::test]
    async fn a_failed_revocation_refresh_keeps_the_old_list_but_takes_the_new_index() {
        let e = added().await;
        let old_rev = e.row().await.revocations.unwrap();
        e.publish_index(
            &Reg {
                serial: 8,
                ..Reg::default()
            },
            &e.root,
        );
        // Each way the revocation file can go wrong.
        let cases: Vec<(&str, Setup)> = vec![
            (
                "blocked",
                Box::new(|e| e.mock.route(&url("revocations.json"), Script::Status(404))),
            ),
            (
                "older serial",
                Box::new(|e| e.publish_revocations(ID, 2, &e.root)),
            ),
            (
                "unknown signer",
                Box::new(|e| e.publish_revocations(ID, 4, &e.other)),
            ),
            (
                "bad signature",
                Box::new(|e| {
                    let b = revocations(ID, 4);
                    e.mock.serve(&url("revocations.json"), &b);
                    e.mock.serve(
                        &url("revocations.json.sig"),
                        &sig(RegistryFile::Revocations, b"other", &e.root),
                    );
                }),
            ),
        ];
        for (name, setup) in cases {
            setup(&e);
            let r = e.client.refresh(ID).await.unwrap();
            assert!(
                matches!(r.revocations, RevocationsOutcome::Failed { .. }),
                "{name}: {:?}",
                r.revocations
            );
            let row = e.row().await;
            assert_eq!(row.index_serial, 8, "{name}: the index should still update");
            assert_eq!(
                row.revocations.as_ref(),
                Some(&old_rev),
                "{name}: old revocations must stay"
            );
            assert!(
                row.last_error
                    .as_deref()
                    .unwrap()
                    .contains("Revocations were not refreshed"),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn a_registry_pinned_by_the_user_must_keep_the_same_signer() {
        let e = Env::new().await;
        e.publish_index(
            &Reg {
                revocations: false,
                ..Reg::default()
            },
            &e.other,
        );
        let pin = key_id(&e.other.verifying_key());
        e.client.add(BASE, Some(&pin)).await.unwrap();
        // A different unknown key takes over the registry.
        let thief = SigningKey::generate(&mut OsRng);
        e.publish_index(
            &Reg {
                serial: 8,
                revocations: false,
                ..Reg::default()
            },
            &thief,
        );
        let err = e.client.refresh(ID).await.unwrap_err();
        assert_eq!(err.code(), "signer_changed");
        assert_eq!(e.row().await.index_serial, 7);
        // The pinned signer itself is fine.
        e.publish_index(
            &Reg {
                serial: 8,
                revocations: false,
                ..Reg::default()
            },
            &e.other,
        );
        assert_eq!(e.client.refresh(ID).await.unwrap().registry.serial, 8);
    }

    #[tokio::test]
    async fn a_pinned_registry_that_becomes_anchored_is_upgraded() {
        let e = Env::new().await;
        e.publish_index(
            &Reg {
                revocations: false,
                ..Reg::default()
            },
            &e.other,
        );
        let pin = key_id(&e.other.verifying_key());
        e.client.add(BASE, Some(&pin)).await.unwrap();
        assert_eq!(e.row().await.trust, "pinned");
        // Same contents, now signed by the anchor.
        let bytes = index(
            &Reg {
                revocations: false,
                ..Reg::default()
            },
            &e.other,
        );
        e.mock.serve(&url("index.json"), &bytes);
        e.mock.serve(
            &url("index.json.sig"),
            &sig(RegistryFile::Index, &bytes, &e.root),
        );
        let r = e.client.refresh(ID).await.unwrap();
        assert_eq!(r.registry.trust, "anchored");
        assert_eq!(r.registry.publisher, "Test Root");
        assert!(e.row().await.pinned_key.is_none());
    }

    #[tokio::test]
    async fn refreshing_an_unknown_registry_is_not_found() {
        let e = Env::new().await;
        assert_eq!(
            e.client
                .refresh("registry:nope.x")
                .await
                .unwrap_err()
                .code(),
            "not_found"
        );
    }

    // ── Removing, listing, staleness ──────────────────────────────────────────

    #[tokio::test]
    async fn removing_deletes_everything_and_the_address_can_be_added_again() {
        let e = added().await;
        e.client.remove(ID).await.unwrap();
        assert_eq!(e.count().await, 0);
        assert_eq!(e.client.remove(ID).await.unwrap_err().code(), "not_found");
        assert_eq!(e.client.refresh(ID).await.unwrap_err().code(), "not_found");
        assert!(e.client.add(BASE, None).await.is_ok());
    }

    #[tokio::test]
    async fn staleness_is_reported_not_enforced() {
        let e = added().await;
        e.clock.store(NOW + 20 * DAY, Ordering::SeqCst);
        let s = e.client.get(ID).await.unwrap();
        assert!(!s.stale, "the index lasts 90 days");
        assert!(s.revocations.unwrap().stale, "revocations last 14 days");
        e.clock.store(NOW + 100 * DAY, Ordering::SeqCst);
        assert!(e.client.get(ID).await.unwrap().stale);
        // The cache is still usable: stale is a state, not an error.
        assert!(e.client.cached(ID).await.unwrap().index.stale);
    }

    #[tokio::test]
    async fn list_is_ordered_by_when_registries_were_added() {
        let e = Env::new().await;
        e.publish(&Reg::default());
        e.client.add(BASE, None).await.unwrap();
        e.clock.store(NOW + 10, Ordering::SeqCst);
        // A second registry on another address.
        let base2 = "https://other.test/r/";
        let bytes = index(
            &Reg {
                id: "registry:sh.test.second",
                revocations: false,
                ..Reg::default()
            },
            &e.root,
        );
        e.mock.serve(&format!("{base2}index.json"), &bytes);
        e.mock.serve(
            &format!("{base2}index.json.sig"),
            &sig(RegistryFile::Index, &bytes, &e.root),
        );
        e.client.add(base2, None).await.unwrap();
        let ids: Vec<String> = e
            .client
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        assert_eq!(
            ids,
            vec![ID.to_string(), "registry:sh.test.second".to_string()]
        );
    }

    // ── The database is not trusted ───────────────────────────────────────────

    #[tokio::test]
    async fn a_modified_cache_fails_verification_whatever_the_table_says() {
        let tamper: Vec<(&str, &str)> = vec![
            (
                "index_json",
                "UPDATE registries SET index_json = ? WHERE id = ?",
            ),
            (
                "index_sig",
                "UPDATE registries SET index_sig = ? WHERE id = ?",
            ),
            (
                "rev_json",
                "UPDATE registries SET rev_json = ? WHERE id = ?",
            ),
            ("rev_sig", "UPDATE registries SET rev_sig = ? WHERE id = ?"),
        ];
        for (col, sql) in tamper {
            let e = added().await;
            assert!(e.client.cached(ID).await.is_ok());
            let row = e.row().await;
            let current: Vec<u8> = match col {
                "index_json" => row.index_json.clone(),
                "index_sig" => row.index_sig.clone(),
                "rev_json" => row.revocations.as_ref().unwrap().json.clone(),
                _ => row.revocations.as_ref().unwrap().sig.clone(),
            };
            let mut bad = current.clone();
            let i = bad.len() / 2;
            bad[i] ^= 1;
            sqlx::query(sql)
                .bind(bad)
                .bind(ID)
                .execute(&e.pool)
                .await
                .unwrap();
            assert!(
                e.client.cached(ID).await.is_err(),
                "{col} was modified but still verified"
            );
        }
    }

    #[tokio::test]
    async fn a_cache_whose_trust_label_was_edited_is_still_checked_against_the_anchors() {
        let e = Env::new().await;
        e.publish_index(
            &Reg {
                revocations: false,
                ..Reg::default()
            },
            &e.other,
        );
        let pin = key_id(&e.other.verifying_key());
        e.client.add(BASE, Some(&pin)).await.unwrap();
        // Someone edits the row to say "anchored" and drops the pin.
        sqlx::query("UPDATE registries SET trust = 'anchored', pinned_key = NULL WHERE id = ?")
            .bind(ID)
            .execute(&e.pool)
            .await
            .unwrap();
        assert_eq!(
            e.client.cached(ID).await.unwrap_err().code(),
            "signer_changed"
        );
    }

    #[tokio::test]
    async fn a_cached_revocation_list_signed_by_an_untrusted_key_is_refused() {
        let e = added().await;
        // Replace the stored revocations with a perfectly valid list signed by a stranger.
        let bytes = revocations(ID, 3);
        let good_sig = sig(RegistryFile::Revocations, &bytes, &e.other);
        sqlx::query("UPDATE registries SET rev_json = ?, rev_sig = ? WHERE id = ?")
            .bind(&bytes)
            .bind(&good_sig)
            .bind(ID)
            .execute(&e.pool)
            .await
            .unwrap();
        assert_eq!(
            e.client.cached(ID).await.unwrap_err().code(),
            "revocations_untrusted"
        );
    }

    #[tokio::test]
    async fn a_certificate_named_like_the_pin_label_does_not_count_as_a_pin() {
        // The root may name a publisher anything, including the words used for a pinned key.
        // That is still an anchored registry, not one the user pinned.
        let e = Env::new().await;
        let registry_key = SigningKey::generate(&mut OsRng);
        let cert = issue_certificate(
            &e.root,
            &Certificate {
                schema: 1,
                subject: key_id(&registry_key.verifying_key()),
                name: PINNED_NAME.into(),
                not_before: NOW - 100_000,
                not_after: NOW + 100_000_000,
                scope: vec!["registry:sh.test.".into()],
            },
        )
        .unwrap();
        let bytes = index(
            &Reg {
                revocations: false,
                ..Reg::default()
            },
            &registry_key,
        );
        e.mock.serve(&url("index.json"), &bytes);
        let signature = sign_registry_file(RegistryFile::Index, &bytes, &registry_key, Some(cert));
        e.mock.serve(
            &url("index.json.sig"),
            &serde_json::to_vec(&signature).unwrap(),
        );
        e.client.add(BASE, None).await.unwrap();
        let row = e.row().await;
        assert_eq!(row.trust, "anchored");
        assert!(row.pinned_key.is_none());
    }

    // ── Real data ─────────────────────────────────────────────────────────────

    fn repo_file(rel: &str) -> Vec<u8> {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel);
        std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
    }

    /// The shared spec vectors, through the whole client, with the vectors' own test root.
    #[tokio::test]
    async fn the_spec_vectors_work_end_to_end_through_the_client() {
        let manifest: Value =
            serde_json::from_slice(&repo_file("spec/registry/vectors/vectors.json")).unwrap();
        let root = parse_key_id(manifest["keys"]["root"]["keyid"].as_str().unwrap()).unwrap();
        let e = Env::new().await;
        let client = RegistryClient::new(
            e.pool.clone(),
            e.mock.clone(),
            vec![Anchor {
                key: root,
                name: "Test Root".into(),
            }],
            Arc::new(|| 1_790_000_000),
        );
        let v = |f: &str| repo_file(&format!("spec/registry/vectors/{f}"));
        e.mock
            .serve(&url("index.json"), &v("index_root_signed/index.json"));
        e.mock.serve(
            &url("index.json.sig"),
            &v("index_root_signed/index.json.sig"),
        );
        e.mock.serve(
            &url("revocations.json"),
            &v("revocations_ok/revocations.json"),
        );
        e.mock.serve(
            &url("revocations.json.sig"),
            &v("revocations_ok/revocations.json.sig"),
        );
        let s = client.add(BASE, None).await.unwrap();
        assert_eq!(s.id, "registry:sh.enigma.test");
        assert_eq!(s.serial, 7);
        assert_eq!(s.trust, "anchored");
        assert_eq!(s.app_count, 2);
        assert_eq!(
            client.refresh(&s.id).await.unwrap().index,
            IndexOutcome::Unchanged
        );

        // A vector that must fail does fail, and leaves the cache alone.
        e.mock.serve(
            &url("index.json"),
            &v("index_bad_signature_tampered/index.json"),
        );
        e.mock.serve(
            &url("index.json.sig"),
            &v("index_bad_signature_tampered/index.json.sig"),
        );
        assert_eq!(
            client.refresh(&s.id).await.unwrap_err().code(),
            "bad_signature"
        );
        assert_eq!(client.get(&s.id).await.unwrap().serial, 7);
    }

    /// The registry actually published on the site, with the anchors compiled into this build.
    #[tokio::test]
    async fn the_published_registry_is_added_with_the_production_anchors() {
        let index = repo_file("web/registry/v1/index.json");
        let issued: Value = serde_json::from_slice(&index).unwrap();
        // A clock a few days after the index was built: after the registry certificate was
        // issued (which happens when the maintainer signs), well inside every validity period.
        let now = issued["issued_at"].as_i64().unwrap() + 3 * DAY;

        let e = Env::new().await;
        let client = RegistryClient::new(
            e.pool.clone(),
            e.mock.clone(),
            crate::trust::production_anchors(),
            Arc::new(move || now),
        );
        let site = "https://sanctum.enigma.sh/registry/v1/";
        for f in [
            "index.json",
            "index.json.sig",
            "revocations.json",
            "revocations.json.sig",
        ] {
            e.mock.serve(
                &format!("{site}{f}"),
                &repo_file(&format!("web/registry/v1/{f}")),
            );
        }
        let s = client.add(site, None).await.unwrap();
        assert_eq!(s.id, "registry:sh.enigma.public");
        assert_eq!(s.trust, "anchored");
        assert_eq!(s.publisher, "Enigma Technologies Solutions");
        assert!(s.app_count >= 2);
        assert!(!s.stale);
        assert!(client.cached(&s.id).await.is_ok());
        // Without the Enigma root the same files are not accepted.
        let e2 = Env::new().await;
        let outsider = RegistryClient::new(
            e2.pool.clone(),
            e.mock.clone(),
            vec![],
            Arc::new(move || now),
        );
        assert_eq!(
            outsider.add(site, None).await.unwrap_err().code(),
            "untrusted_signer"
        );
    }

    /// Talks to the real site over real HTTPS with the real transport. Needs a network, so it
    /// is not part of the normal run: `cargo test --lib live_site -- --ignored`.
    #[tokio::test]
    #[ignore = "needs network access to sanctum.enigma.sh"]
    async fn live_site_is_reachable_and_verifies() {
        let e = Env::new().await;
        let client = RegistryClient::new(
            e.pool.clone(),
            Arc::new(crate::registry::fetch::ReqwestTransport::new().unwrap()),
            crate::trust::production_anchors(),
            Arc::new(system_clock),
        );
        let s = client
            .add("https://sanctum.enigma.sh/registry/v1/", None)
            .await
            .unwrap();
        assert_eq!(s.id, "registry:sh.enigma.public");
        assert_eq!(s.trust, "anchored");
        assert_eq!(s.publisher, "Enigma Technologies Solutions");
        assert!(
            !s.stale,
            "the live index has expired; run scripts/sign-registry.sh --renew"
        );
        assert_eq!(
            client.refresh(&s.id).await.unwrap().index,
            IndexOutcome::Unchanged
        );
        // Plain http is refused without touching the network.
        assert_eq!(
            client
                .add("http://sanctum.enigma.sh/registry/v1/", None)
                .await
                .unwrap_err()
                .code(),
            "insecure_url"
        );
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn migrations_are_repeatable_and_leave_existing_rows_alone() {
        let e = added().await;
        crate::db::run_migrations(&e.pool).await.unwrap();
        crate::db::run_migrations(&e.pool).await.unwrap();
        assert_eq!(e.count().await, 1);
        assert_eq!(e.client.cached(ID).await.unwrap().index.index.serial, 7);
    }

    #[tokio::test]
    async fn the_trust_column_only_accepts_known_values() {
        let e = added().await;
        let r = sqlx::query("UPDATE registries SET trust = 'trusted-by-me' WHERE id = ?")
            .bind(ID)
            .execute(&e.pool)
            .await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn summaries_serialise_for_the_interface() {
        let e = added().await;
        let v = serde_json::to_value(e.client.get(ID).await.unwrap()).unwrap();
        for key in [
            "id",
            "name",
            "kind",
            "baseUrl",
            "trust",
            "publisher",
            "signer",
            "appCount",
            "serial",
            "issuedAt",
            "expires",
            "stale",
            "revocations",
            "addedAt",
            "lastCheckedAt",
            "lastError",
        ] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        e.publish(&Reg {
            serial: 8,
            ..Reg::default()
        });
        let r = serde_json::to_value(e.client.refresh(ID).await.unwrap()).unwrap();
        assert_eq!(r["index"]["state"], "updated");
        assert_eq!(r["index"]["fromSerial"], 7);
        assert_eq!(r["revocations"]["state"], "unchanged");
    }
}
