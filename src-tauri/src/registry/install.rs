// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Install from a registry: the catalogue, one app, or several.
//!
//! A registry decides **what is offered**. It decides nothing about what a tool may do, and
//! nothing about how far a tool is trusted:
//!
//! - The bundle goes through exactly the same verification, local scan, app-identity and
//!   downgrade checks as a file the user opens (`install_bundle_inner`). A bundle signed by
//!   an unknown key installs as an unknown signer even from an anchored registry.
//! - Before anything is written, the bundle's signed statement must say what the index said:
//!   same app, version, checksum, declared capabilities and signer key. A signed index that
//!   misdescribes a bundle is refused, whoever signed the index.
//! - The tool starts with **no approvals**. Installing, updating, or installing everything
//!   never grants a capability; the user approves each one on the normal screen.
//! - A version the registry has revoked is refused. A licensed entry is listed but not
//!   installable by this version of Sanctum.
//!
//! The catalogue comes from the cached index, verified again on every use, so installing
//! works offline from the last good copy. Refresh the registry first to see newer versions.

use super::client::{normalize_base, resolve, ClientError, RegistryClient};
use super::fetch::{fetch, Limits};
use crate::commands::bundle::{install_bundle_inner, BundleInstall};
use sanctum_bundle::registry::{check_asset, Access, AppEntry, Kind, Revocations, VersionEntry};
use sanctum_bundle::{compare_versions, parse_bundle, parse_version, verify};
use serde::Serialize;
use sqlx::Row;
use std::path::Path;
use std::time::Duration;

// ── What the interface sees ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogVersion {
    pub version: String,
    pub published_at: i64,
    /// Capabilities the publisher declares for this version. The approval screen, not this
    /// list, is what grants anything.
    pub declared: Vec<serde_json::Value>,
    pub size: u64,
    pub revoked: bool,
}

/// Where an app stands on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallState {
    NotInstalled,
    /// The listed latest version (or a newer one) is installed.
    Installed,
    UpdateAvailable,
    /// Listed but not installable by this version of Sanctum.
    Licensed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogApp {
    pub app_id: String,
    pub name: String,
    pub summary: String,
    pub publisher_key: String,
    pub publisher_name: String,
    pub latest: String,
    pub versions: Vec<CatalogVersion>,
    /// Highest version installed from any source, if the app is in the library.
    pub installed_version: Option<String>,
    pub state: InstallState,
    pub latest_revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogue {
    pub registry_id: String,
    pub registry_name: String,
    pub stale: bool,
    pub revocations_stale: bool,
    pub apps: Vec<CatalogApp>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum InstallOutcome {
    #[serde(rename_all = "camelCase")]
    Installed {
        install: Box<BundleInstall>,
        /// Things worth telling the user, for example an out-of-date catalogue.
        notes: Vec<String>,
    },
    /// This exact version is already in the library. Nothing was changed.
    #[serde(rename_all = "camelCase")]
    AlreadyInstalled { version: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum BatchOutcome {
    #[serde(rename_all = "camelCase")]
    Installed {
        tool_id: String,
        version: String,
        trust: String,
    },
    #[serde(rename_all = "camelCase")]
    AlreadyInstalled { version: String },
    #[serde(rename_all = "camelCase")]
    Failed { code: String, message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub app_id: String,
    pub name: String,
    #[serde(flatten)]
    pub outcome: BatchOutcome,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn is_revoked(rev: Option<&Revocations>, checksum: &str) -> Option<String> {
    rev?.entries
        .iter()
        .find(|e| e.checksum == checksum)
        .map(|e| e.reason.clone())
}

/// `sha256:abc` to the library's version id `abc`.
fn version_id(checksum: &str) -> &str {
    checksum.trim_start_matches("sha256:")
}

fn highest(versions: &[String]) -> Option<String> {
    versions
        .iter()
        .filter_map(|v| parse_version(v).map(|p| (p, v)))
        .max_by(|a, b| compare_versions(&a.0, &b.0))
        .map(|(_, v)| v.clone())
}

async fn installed_versions(
    pool: &sqlx::SqlitePool,
    app_id: &str,
) -> Result<Vec<(String, String)>, ClientError> {
    let rows = sqlx::query("SELECT version_id, version FROM bundle_provenance WHERE app_id = $1")
        .bind(app_id)
        .fetch_all(pool)
        .await
        .map_err(|e| ClientError::BundleRefused(e.to_string()))?;
    Ok(rows
        .iter()
        .map(|r| (r.get("version_id"), r.get("version")))
        .collect())
}

fn find_app<'a>(apps: &'a [AppEntry], app_id: &str) -> Result<&'a AppEntry, ClientError> {
    apps.iter()
        .find(|a| a.app_id == app_id)
        .ok_or_else(|| ClientError::AppNotFound(app_id.to_string()))
}

fn pick_version<'a>(
    app: &'a AppEntry,
    wanted: Option<&str>,
) -> Result<&'a VersionEntry, ClientError> {
    let v = wanted.unwrap_or(&app.latest);
    app.versions
        .iter()
        .find(|x| x.version == v)
        .ok_or_else(|| ClientError::VersionNotFound {
            app_id: app.app_id.clone(),
            version: v.to_string(),
        })
}

impl RegistryClient {
    /// The catalogue from the cached, re-verified index, with what is installed and what is
    /// withdrawn. No network.
    pub async fn catalogue(&self, registry_id: &str) -> Result<Catalogue, ClientError> {
        let cached = self.cached(registry_id).await?;
        let index = &cached.index.index;
        let rev = cached.revocations.as_ref().map(|r| &r.revocations);
        let licensed_registry = index.kind == Kind::Licensed;

        let mut apps = Vec::new();
        for app in &index.apps {
            let installed = installed_versions(&self.pool, &app.app_id).await?;
            let installed_version =
                highest(&installed.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>());
            let latest = app.versions.iter().find(|v| v.version == app.latest);
            let state = if licensed_registry || app.access == Access::Licensed {
                InstallState::Licensed
            } else {
                match (&installed_version, parse_version(&app.latest)) {
                    (None, _) => InstallState::NotInstalled,
                    (Some(i), Some(l)) => match parse_version(i) {
                        Some(i) if compare_versions(&i, &l) != std::cmp::Ordering::Less => {
                            InstallState::Installed
                        }
                        _ => InstallState::UpdateAvailable,
                    },
                    (Some(_), None) => InstallState::NotInstalled,
                }
            };
            apps.push(CatalogApp {
                app_id: app.app_id.clone(),
                name: app.name.clone(),
                summary: app.summary.clone(),
                publisher_key: app.publisher.keyid.clone(),
                publisher_name: app.publisher.name.clone(),
                latest: app.latest.clone(),
                versions: app
                    .versions
                    .iter()
                    .map(|v| CatalogVersion {
                        version: v.version.clone(),
                        published_at: v.published_at,
                        declared: v.declared.clone(),
                        size: v.bundle.size,
                        revoked: is_revoked(rev, &v.checksum).is_some(),
                    })
                    .collect(),
                installed_version,
                state,
                latest_revoked: latest
                    .map(|v| is_revoked(rev, &v.checksum).is_some())
                    .unwrap_or(false),
            });
        }
        Ok(Catalogue {
            registry_id: index.id.clone(),
            registry_name: index.name.clone(),
            stale: cached.index.stale,
            revocations_stale: cached.revocations.as_ref().is_some_and(|r| r.stale),
            apps,
        })
    }

    /// Install one app from a registry. `version` defaults to the listed latest.
    pub async fn install(
        &self,
        data_dir: &Path,
        registry_id: &str,
        app_id: &str,
        version: Option<&str>,
    ) -> Result<InstallOutcome, ClientError> {
        let cached = self.cached(registry_id).await?;
        let index = &cached.index.index;
        let app = find_app(&index.apps, app_id)?;
        let entry = pick_version(app, version)?;

        // 1. Is it offered for installing at all?
        if index.kind == Kind::Licensed || app.access == Access::Licensed {
            return Err(ClientError::NotInstallable(format!(
                "{} is a licensed app. This version of Sanctum lists licensed apps but cannot install them.",
                app.name
            )));
        }
        let rev = cached.revocations.as_ref().map(|r| &r.revocations);
        if let Some(reason) = is_revoked(rev, &entry.checksum) {
            return Err(ClientError::Revoked {
                app_id: app.app_id.clone(),
                version: entry.version.clone(),
                reason,
            });
        }

        // 2. Already here? Say so, change nothing.
        let installed = installed_versions(&self.pool, &app.app_id).await?;
        if installed
            .iter()
            .any(|(vid, _)| vid == version_id(&entry.checksum))
        {
            return Ok(InstallOutcome::AlreadyInstalled {
                version: entry.version.clone(),
            });
        }

        // 3. Download. The size in the index is the cap; the hash is checked before anything
        //    else looks at the bytes.
        let row = super::store::get(&self.pool, registry_id)
            .await?
            .ok_or(ClientError::NotFound)?;
        let base = normalize_base(&row.base_url)?;
        let url = resolve(&base, &entry.bundle.path)?;
        let limits = Limits {
            max_bytes: entry.bundle.size as usize,
            total_timeout: Duration::from_secs(120),
            ..Limits::new(entry.bundle.size as usize)
        };
        let bytes = fetch(&*self.transport, &url, limits).await?;
        check_asset(&entry.bundle, &bytes)?;
        let json = String::from_utf8(bytes).map_err(|_| {
            ClientError::BundleRefused("The bundle is not valid UTF-8 text.".into())
        })?;

        // 4. The signed statement must say what the index said, before anything is written.
        let now = self.now();
        let bundle = parse_bundle(&json).map_err(|e| ClientError::BundleRefused(e.to_string()))?;
        let verified = verify(&bundle, &self.anchors, now)
            .map_err(|e| ClientError::BundleRefused(format!("Refusing to install: {e}.")))?;
        let s = &verified.statement;
        let mismatch = if s.app_id != app.app_id {
            Some("app id")
        } else if s.version != entry.version {
            Some("version")
        } else if s.checksum != entry.checksum {
            Some("checksum")
        } else if s.declared != entry.declared {
            Some("declared capabilities")
        } else if verified.signer_key != app.publisher.keyid {
            Some("publisher key")
        } else {
            None
        };
        if let Some(what) = mismatch {
            return Err(ClientError::Inconsistent(what.to_string()));
        }

        // 5. The normal install path: scan, undeclared-capability check, app identity,
        //    downgrade rule, storage, provenance. It grants nothing.
        let install = install_bundle_inner(&self.pool, data_dir, &json, &self.anchors, now)
            .await
            .map_err(ClientError::BundleRefused)?;

        let mut notes = Vec::new();
        if cached.index.stale {
            notes.push(
                "This registry's catalogue is out of date. Refresh it to see newer versions and withdrawals."
                    .to_string(),
            );
        }
        if cached.revocations.as_ref().is_some_and(|r| r.stale) {
            notes.push(
                "This registry's revocation list is out of date, so a recent withdrawal may not be known yet."
                    .to_string(),
            );
        }
        Ok(InstallOutcome::Installed {
            install: Box::new(install),
            notes,
        })
    }

    /// Install several apps, or every installable app when `app_ids` is `None`. One failure
    /// does not stop the others. Nothing is approved for any of them.
    pub async fn install_many(
        &self,
        data_dir: &Path,
        registry_id: &str,
        app_ids: Option<&[String]>,
    ) -> Result<Vec<BatchItem>, ClientError> {
        let catalogue = self.catalogue(registry_id).await?;
        let wanted: Vec<&CatalogApp> = match app_ids {
            Some(ids) => {
                let mut out = Vec::new();
                for id in ids {
                    out.push(
                        catalogue
                            .apps
                            .iter()
                            .find(|a| &a.app_id == id)
                            .ok_or_else(|| ClientError::AppNotFound(id.clone()))?,
                    );
                }
                out
            }
            None => catalogue.apps.iter().collect(),
        };
        let mut items = Vec::new();
        for app in wanted {
            let outcome = if app.state == InstallState::Licensed && app_ids.is_none() {
                // "All" does not mean "everything we cannot install".
                continue;
            } else {
                match self.install(data_dir, registry_id, &app.app_id, None).await {
                    Ok(InstallOutcome::Installed { install, .. }) => BatchOutcome::Installed {
                        tool_id: install.tool.id.clone(),
                        version: install.provenance.version.clone(),
                        trust: install.provenance.trust.clone(),
                    },
                    Ok(InstallOutcome::AlreadyInstalled { version }) => {
                        BatchOutcome::AlreadyInstalled { version }
                    }
                    Err(e) => BatchOutcome::Failed {
                        code: e.code().to_string(),
                        message: e.to_string(),
                    },
                }
            };
            items.push(BatchItem {
                app_id: app.app_id.clone(),
                name: app.name.clone(),
                outcome,
            });
        }
        Ok(items)
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::super::fetch::testing::{Mock, Script};
    use super::*;
    use crate::commands::scan::scan_html;
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;
    use sanctum_bundle::{
        checksum_of, issue_certificate, key_id, sign_bundle, sign_registry_file, Anchor,
        Certificate, RegistryFile, SignedBlob, StatementInput,
    };
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Arc;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 86_400;
    const BASE: &str = "https://registry.test/v1/";
    const ID: &str = "registry:sh.test.public";

    // ── Tools and bundles ─────────────────────────────────────────────────────

    #[derive(Clone)]
    struct Tool {
        app: &'static str,
        version: &'static str,
        html: String,
        /// What the bundle declares. Defaults to exactly what the scan finds.
        declared: Vec<Value>,
    }

    fn declared_for(html: &str) -> Vec<Value> {
        scan_html(html)
            .iter()
            .map(|c| serde_json::to_value(c).unwrap())
            .collect()
    }

    fn tool(app: &'static str, version: &'static str, body: &str) -> Tool {
        let html = format!(
            "<!doctype html><html><head><title>{app}</title></head><body>{body}</body></html>"
        );
        Tool {
            app,
            version,
            declared: declared_for(&html),
            html,
        }
    }

    /// Asks for nothing.
    fn plain(app: &'static str, version: &'static str) -> Tool {
        tool(app, version, &format!("<p>{app} {version}</p>"))
    }
    /// Uses storage.
    fn storing(app: &'static str, version: &'static str) -> Tool {
        tool(
            app,
            version,
            &format!("<script>localStorage.setItem('k','{version}')</script>"),
        )
    }
    /// Calls a network host.
    fn calling(app: &'static str, version: &'static str) -> Tool {
        tool(
            app,
            version,
            &format!("<script>fetch(\"https://api.test/{version}\")</script>"),
        )
    }

    #[derive(Clone)]
    struct Listed {
        tool: Tool,
        bundle: String,
        signer: String,
    }

    // ── The world ─────────────────────────────────────────────────────────────

    struct World {
        client: RegistryClient,
        mock: Arc<Mock>,
        pool: sqlx::SqlitePool,
        dir: std::path::PathBuf,
        root: SigningKey,
        publisher: SigningKey,
        publisher_cert: SignedBlob,
        rogue: SigningKey,
        clock: Arc<AtomicI64>,
    }

    impl World {
        async fn new() -> World {
            let dir =
                std::env::temp_dir().join(format!("sanctum-install-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("tools")).unwrap();
            let pool = crate::db::create_pool(&dir).await.unwrap();
            crate::db::run_migrations(&pool).await.unwrap();
            let root = SigningKey::generate(&mut OsRng);
            let publisher = SigningKey::generate(&mut OsRng);
            let publisher_cert = issue_certificate(
                &root,
                &Certificate {
                    schema: 1,
                    subject: key_id(&publisher.verifying_key()),
                    name: "Test Publisher".into(),
                    not_before: NOW - 100_000,
                    not_after: NOW + 100_000_000,
                    scope: vec!["sh.test.".into()],
                },
            )
            .unwrap();
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
            World {
                client,
                mock,
                pool,
                dir,
                root,
                publisher,
                publisher_cert,
                rogue: SigningKey::generate(&mut OsRng),
                clock,
            }
        }

        fn bundle_with(&self, t: &Tool, key: &SigningKey, cert: Option<SignedBlob>) -> String {
            let b = sign_bundle(
                &t.html,
                StatementInput {
                    app_id: format!("sh.test.{}", t.app),
                    name: t.app.to_string(),
                    version: t.version.to_string(),
                    declared: t.declared.clone(),
                    issued_at: NOW - 5000,
                },
                key,
                cert,
            )
            .unwrap();
            serde_json::to_string(&b).unwrap()
        }

        /// A bundle signed by the publisher whose certificate chains to the anchor.
        fn listed(&self, t: Tool) -> Listed {
            Listed {
                bundle: self.bundle_with(&t, &self.publisher, Some(self.publisher_cert.clone())),
                signer: key_id(&self.publisher.verifying_key()),
                tool: t,
            }
        }

        /// A bundle signed by a key nobody vouches for.
        fn listed_by_stranger(&self, t: Tool) -> Listed {
            Listed {
                bundle: self.bundle_with(&t, &self.rogue, None),
                signer: key_id(&self.rogue.verifying_key()),
                tool: t,
            }
        }

        /// Serve a registry listing these bundles. `revoked` are tool checksums to withdraw.
        fn publish(&self, items: &[Listed], serial: u64, revoked: &[String]) -> Value {
            self.publish_with(items, serial, revoked, "public", "free")
        }

        fn publish_with(
            &self,
            items: &[Listed],
            serial: u64,
            revoked: &[String],
            kind: &str,
            access: &str,
        ) -> Value {
            let mut by_app: BTreeMap<&str, Vec<&Listed>> = BTreeMap::new();
            for l in items {
                by_app.entry(l.tool.app).or_default().push(l);
            }
            let mut apps = Vec::new();
            for (app, versions) in by_app {
                let latest = versions.iter().map(|l| l.tool.version).max().unwrap();
                let first = versions[0];
                let entries: Vec<Value> = versions
                    .iter()
                    .map(|l| {
                        let path = format!("bundles/sh.test.{app}-{}.sanctum", l.tool.version);
                        self.mock
                            .serve(&format!("{BASE}{path}"), l.bundle.as_bytes());
                        json!({
                            "version": l.tool.version,
                            "published_at": NOW - 4000,
                            "bundle": {
                                "path": path,
                                "sha256": sanctum_bundle::registry::sha256_of(l.bundle.as_bytes()),
                                "size": l.bundle.len()
                            },
                            "checksum": checksum_of(&l.tool.html),
                            "declared": l.tool.declared
                        })
                    })
                    .collect();
                apps.push(json!({
                    "app_id": format!("sh.test.{app}"),
                    "name": app,
                    "summary": format!("{app} summary"),
                    "publisher": { "keyid": first.signer, "name": "Test Publisher" },
                    "access": access,
                    "latest": latest,
                    "detail": {
                        "path": format!("apps/sh.test.{app}.json"),
                        "sha256": sanctum_bundle::registry::sha256_of(b"{}"),
                        "size": 2
                    },
                    "versions": entries
                }));
            }
            let doc = json!({
                "format": "sanctum-registry/1",
                "id": ID,
                "name": "Test Registry",
                "kind": kind,
                "serial": serial,
                "issued_at": NOW - 1000,
                "expires": NOW + 90 * DAY,
                "revocations": "revocations.json",
                "apps": apps
            });
            let index = serde_json::to_vec_pretty(&doc).unwrap();
            self.mock.serve(&format!("{BASE}index.json"), &index);
            self.mock.serve(
                &format!("{BASE}index.json.sig"),
                &serde_json::to_vec(&sign_registry_file(
                    RegistryFile::Index,
                    &index,
                    &self.root,
                    None,
                ))
                .unwrap(),
            );
            let entries: Vec<Value> = revoked
                .iter()
                .map(|c| {
                    json!({
                        "checksum": c, "app_id": "sh.test.x", "reason": "vulnerable", "revoked_at": NOW - 10
                    })
                })
                .collect();
            let rev = serde_json::to_vec_pretty(&json!({
                "format": "sanctum-registry-revocations/1",
                "registry": ID,
                "serial": serial,
                "issued_at": NOW - 500,
                "expires": NOW + 14 * DAY,
                "entries": entries
            }))
            .unwrap();
            self.mock.serve(&format!("{BASE}revocations.json"), &rev);
            self.mock.serve(
                &format!("{BASE}revocations.json.sig"),
                &serde_json::to_vec(&sign_registry_file(
                    RegistryFile::Revocations,
                    &rev,
                    &self.root,
                    None,
                ))
                .unwrap(),
            );
            doc
        }

        async fn add(&self) {
            self.client.add(BASE, None).await.unwrap();
        }

        async fn install(&self, app: &str) -> Result<InstallOutcome, ClientError> {
            self.client
                .install(&self.dir, ID, &format!("sh.test.{app}"), None)
                .await
        }

        async fn install_version(&self, app: &str, v: &str) -> Result<InstallOutcome, ClientError> {
            self.client
                .install(&self.dir, ID, &format!("sh.test.{app}"), Some(v))
                .await
        }

        async fn tools(&self) -> i64 {
            sqlx::query("SELECT COUNT(*) AS n FROM tools")
                .fetch_one(&self.pool)
                .await
                .unwrap()
                .get("n")
        }

        async fn versions(&self) -> i64 {
            sqlx::query("SELECT COUNT(*) AS n FROM tool_versions")
                .fetch_one(&self.pool)
                .await
                .unwrap()
                .get("n")
        }

        async fn approvals(&self) -> Vec<String> {
            sqlx::query("SELECT approvals FROM tools")
                .fetch_all(&self.pool)
                .await
                .unwrap()
                .iter()
                .map(|r| r.get::<String, _>("approvals"))
                .collect()
        }
    }

    fn installed(o: InstallOutcome) -> BundleInstall {
        match o {
            InstallOutcome::Installed { install, .. } => *install,
            other => panic!("expected an install, got {other:?}"),
        }
    }

    // ── Installing: the rules that must never bend ────────────────────────────

    #[tokio::test]
    async fn installing_stores_the_tool_with_its_provenance_and_no_approvals() {
        let w = World::new().await;
        let t = storing("alpha", "1.0.0");
        w.publish(&[w.listed(t.clone())], 1, &[]);
        w.add().await;
        let i = installed(w.install("alpha").await.unwrap());
        assert!(i.is_new_tool);
        assert_eq!(i.tool.name, "alpha");
        assert_eq!(i.provenance.app_id, "sh.test.alpha");
        assert_eq!(i.provenance.version, "1.0.0");
        assert_eq!(i.provenance.trust, "verified");
        assert_eq!(
            i.provenance.publisher_name.as_deref(),
            Some("Test Publisher")
        );
        assert_eq!(
            i.version.id,
            checksum_of(&t.html).trim_start_matches("sha256:")
        );
        assert!(
            i.tool.approvals.is_empty(),
            "a new tool starts with nothing approved"
        );
        assert_eq!(w.approvals().await, vec!["[]".to_string()]);
    }

    #[tokio::test]
    async fn a_tool_that_asks_for_the_network_still_starts_with_nothing_approved() {
        let w = World::new().await;
        let t = calling("beta", "1.0.0");
        assert!(
            !t.declared.is_empty(),
            "the test tool must actually ask for something"
        );
        w.publish(&[w.listed(t)], 1, &[]);
        w.add().await;
        let i = installed(w.install("beta").await.unwrap());
        assert!(i.tool.approvals.is_empty());
        assert_eq!(w.approvals().await, vec!["[]".to_string()]);
    }

    #[tokio::test]
    async fn install_all_installs_every_app_and_approves_nothing_for_any_of_them() {
        let w = World::new().await;
        let items = [
            w.listed(plain("one", "1.0.0")),
            w.listed(storing("two", "1.0.0")),
            w.listed(calling("three", "1.0.0")),
        ];
        w.publish(&items, 1, &[]);
        w.add().await;
        let out = w.client.install_many(&w.dir, ID, None).await.unwrap();
        assert_eq!(out.len(), 3);
        for item in &out {
            assert!(
                matches!(item.outcome, BatchOutcome::Installed { .. }),
                "{item:?}"
            );
        }
        assert_eq!(w.tools().await, 3);
        assert_eq!(
            w.approvals().await,
            vec!["[]".to_string(), "[]".to_string(), "[]".to_string()],
            "install all must grant no capability to any tool"
        );
    }

    #[tokio::test]
    async fn the_registry_does_not_raise_a_stranger_signed_bundle_to_verified() {
        let w = World::new().await;
        w.publish(&[w.listed_by_stranger(plain("gamma", "1.0.0"))], 1, &[]);
        w.add().await;
        let i = installed(w.install("gamma").await.unwrap());
        assert_eq!(
            i.provenance.trust, "unknown_signer",
            "an anchored registry vouches for its catalogue, not for the publisher's key"
        );
        assert!(i.provenance.publisher_name.is_none());
    }

    #[tokio::test]
    async fn an_undeclared_capability_is_refused_through_a_registry_too() {
        let w = World::new().await;
        let mut t = calling("delta", "1.0.0");
        t.declared = vec![]; // the publisher signs a declaration that hides the network use
        w.publish(&[w.listed(t)], 1, &[]);
        w.add().await;
        let e = w.install("delta").await.unwrap_err();
        assert_eq!(e.code(), "bundle_refused");
        assert!(e.to_string().contains("did not declare"), "{e}");
        assert_eq!((w.tools().await, w.versions().await), (0, 0));
    }

    // ── What the index claims against what was signed ─────────────────────────

    /// The index misstates exactly one thing about a genuinely signed bundle whose bytes match
    /// the hash the index gives. Each check must be able to catch its field on its own.
    #[tokio::test]
    async fn each_field_the_index_misstates_is_caught_on_its_own() {
        for field in ["app id", "version", "checksum", "declared capabilities"] {
            let w = World::new().await;
            let l = w.listed(storing("eps", "1.0.0"));
            let mut index = w.publish(std::slice::from_ref(&l), 1, &[]);
            let new_path = {
                let app = &mut index["apps"][0];
                match field {
                    "app id" => {
                        app["app_id"] = json!("sh.test.zzz");
                        app["detail"]["path"] = json!("apps/sh.test.zzz.json");
                        let p = "bundles/sh.test.zzz-1.0.0.sanctum";
                        app["versions"][0]["bundle"]["path"] = json!(p);
                        Some(p)
                    }
                    "version" => {
                        app["latest"] = json!("1.0.1");
                        app["versions"][0]["version"] = json!("1.0.1");
                        let p = "bundles/sh.test.eps-1.0.1.sanctum";
                        app["versions"][0]["bundle"]["path"] = json!(p);
                        Some(p)
                    }
                    "checksum" => {
                        app["versions"][0]["checksum"] = json!(checksum_of("<p>other</p>"));
                        None
                    }
                    _ => {
                        app["versions"][0]["declared"] = json!([]);
                        None
                    }
                }
            };
            if let Some(p) = new_path {
                w.mock.serve(&format!("{BASE}{p}"), l.bundle.as_bytes());
            }
            w.sign_and_serve_index(&index);
            w.add().await;
            let app_id = index["apps"][0]["app_id"].as_str().unwrap().to_string();
            let e = w
                .client
                .install(&w.dir, ID, &app_id, None)
                .await
                .unwrap_err();
            assert!(
                matches!(&e, ClientError::Inconsistent(what) if what == field),
                "{field}: {e:?}"
            );
            assert_eq!(
                (w.tools().await, w.versions().await),
                (0, 0),
                "{field} wrote something"
            );
        }
    }

    impl World {
        fn sign_and_serve_index(&self, index: &Value) {
            let bytes = serde_json::to_vec_pretty(index).unwrap();
            self.mock.serve(&format!("{BASE}index.json"), &bytes);
            self.mock.serve(
                &format!("{BASE}index.json.sig"),
                &serde_json::to_vec(&sign_registry_file(
                    RegistryFile::Index,
                    &bytes,
                    &self.root,
                    None,
                ))
                .unwrap(),
            );
        }
    }

    #[tokio::test]
    async fn wrong_bytes_for_a_listed_bundle_are_refused_by_hash_or_size() {
        for (name, mutate) in [
            (
                "flipped byte",
                Box::new(|b: &mut Vec<u8>| b[10] ^= 1) as Box<dyn Fn(&mut Vec<u8>)>,
            ),
            ("longer", Box::new(|b: &mut Vec<u8>| b.push(b' '))),
            (
                "shorter",
                Box::new(|b: &mut Vec<u8>| {
                    b.pop();
                }),
            ),
        ] {
            let w = World::new().await;
            let l = w.listed(plain("zeta", "1.0.0"));
            w.publish(std::slice::from_ref(&l), 1, &[]);
            w.add().await;
            let mut bytes = l.bundle.clone().into_bytes();
            mutate(&mut bytes);
            w.mock
                .serve(&format!("{BASE}bundles/sh.test.zeta-1.0.0.sanctum"), &bytes);
            let e = w.install("zeta").await.unwrap_err();
            assert!(
                matches!(e.code(), "hash_mismatch" | "size_mismatch" | "fetch_failed"),
                "{name}: {}",
                e.code()
            );
            assert_eq!((w.tools().await, w.versions().await), (0, 0), "{name}");
        }
    }

    #[tokio::test]
    async fn a_valid_bundle_swapped_in_for_another_is_caught_by_the_hash() {
        let w = World::new().await;
        let l = w.listed(plain("eta", "1.0.0"));
        w.publish(std::slice::from_ref(&l), 1, &[]);
        w.add().await;
        // A perfectly genuine bundle of the same app and version, with different contents.
        let other = w.listed(tool(
            "eta",
            "1.0.0",
            "<p>something else entirely, and longer than before</p>",
        ));
        w.mock.serve(
            &format!("{BASE}bundles/sh.test.eta-1.0.0.sanctum"),
            other.bundle.as_bytes(),
        );
        let e = w.install("eta").await.unwrap_err();
        assert!(
            matches!(e.code(), "hash_mismatch" | "size_mismatch" | "fetch_failed"),
            "{}",
            e.code()
        );
        assert_eq!(w.tools().await, 0);
    }

    #[tokio::test]
    async fn an_endless_or_oversize_download_is_cut_off() {
        let w = World::new().await;
        let l = w.listed(plain("theta", "1.0.0"));
        w.publish(std::slice::from_ref(&l), 1, &[]);
        w.add().await;
        w.mock.route(
            &format!("{BASE}bundles/sh.test.theta-1.0.0.sanctum"),
            Script::Chunks {
                declared_len: None,
                chunks: (0..2000).map(|_| vec![b'x'; 4096]).collect(),
                delay: std::time::Duration::ZERO,
            },
        );
        let e = w.install("theta").await.unwrap_err();
        assert_eq!(e.code(), "fetch_failed");
        assert_eq!(w.tools().await, 0);
    }

    #[tokio::test]
    async fn network_failures_install_nothing() {
        let w = World::new().await;
        let l = w.listed(plain("iota", "1.0.0"));
        w.publish(std::slice::from_ref(&l), 1, &[]);
        w.add().await;
        for script in [
            Script::Status(404),
            Script::Status(500),
            Script::Down("offline".into()),
        ] {
            w.mock
                .route(&format!("{BASE}bundles/sh.test.iota-1.0.0.sanctum"), script);
            assert_eq!(w.install("iota").await.unwrap_err().code(), "fetch_failed");
        }
        assert_eq!(w.tools().await, 0);
    }

    // ── Withdrawn, licensed and unknown ───────────────────────────────────────

    #[tokio::test]
    async fn a_revoked_version_is_refused_and_its_sibling_still_installs() {
        let w = World::new().await;
        let bad = w.listed(plain("kappa", "1.0.0"));
        let good = w.listed(plain("kappa", "1.0.1"));
        w.publish(&[bad.clone(), good], 1, &[checksum_of(&bad.tool.html)]);
        w.add().await;
        let e = w.install_version("kappa", "1.0.0").await.unwrap_err();
        assert_eq!(e.code(), "revoked");
        assert_eq!(w.tools().await, 0);
        assert!(w.install_version("kappa", "1.0.1").await.is_ok());
    }

    #[tokio::test]
    async fn revoking_the_latest_blocks_the_default_install_and_shows_in_the_catalogue() {
        let w = World::new().await;
        let l = w.listed(plain("lambda", "1.0.0"));
        w.publish(std::slice::from_ref(&l), 1, &[checksum_of(&l.tool.html)]);
        w.add().await;
        assert_eq!(w.install("lambda").await.unwrap_err().code(), "revoked");
        let c = w.client.catalogue(ID).await.unwrap();
        assert!(c.apps[0].latest_revoked);
        assert!(c.apps[0].versions[0].revoked);
        // "Install all" reports it and carries on.
        let out = w.client.install_many(&w.dir, ID, None).await.unwrap();
        assert!(matches!(&out[0].outcome, BatchOutcome::Failed { code, .. } if code == "revoked"));
    }

    #[tokio::test]
    async fn licensed_apps_are_listed_but_not_installable_and_cost_no_download() {
        for (kind, access) in [("public", "licensed"), ("licensed", "free")] {
            let w = World::new().await;
            let l = w.listed(plain("mu", "1.0.0"));
            w.publish_with(std::slice::from_ref(&l), 1, &[], kind, access);
            w.add().await;
            let before = w.mock.call_count();
            assert_eq!(w.install("mu").await.unwrap_err().code(), "not_installable");
            assert_eq!(w.mock.call_count(), before, "no bundle may be downloaded");
            let c = w.client.catalogue(ID).await.unwrap();
            assert_eq!(c.apps[0].state, InstallState::Licensed);
            // "Install all" skips what it cannot install instead of reporting failures.
            assert!(w
                .client
                .install_many(&w.dir, ID, None)
                .await
                .unwrap()
                .is_empty());
            assert_eq!(w.tools().await, 0);
        }
    }

    #[tokio::test]
    async fn unknown_apps_versions_and_registries_are_clear_errors() {
        let w = World::new().await;
        w.publish(&[w.listed(plain("nu", "1.0.0"))], 1, &[]);
        w.add().await;
        assert_eq!(w.install("nope").await.unwrap_err().code(), "app_not_found");
        assert_eq!(
            w.install_version("nu", "9.9.9").await.unwrap_err().code(),
            "version_not_found"
        );
        let e = w
            .client
            .install(&w.dir, "registry:no.such", "sh.test.nu", None)
            .await
            .unwrap_err();
        assert_eq!(e.code(), "not_found");
        let e = w
            .client
            .install_many(&w.dir, ID, Some(&["sh.test.ghost".to_string()]))
            .await
            .unwrap_err();
        assert_eq!(e.code(), "app_not_found");
    }

    // ── Updates, downgrades and repeats ───────────────────────────────────────

    #[tokio::test]
    async fn an_update_keeps_the_tool_and_changes_nothing_the_user_approved() {
        let w = World::new().await;
        w.publish(&[w.listed(storing("xi", "1.0.0"))], 1, &[]);
        w.add().await;
        let first = installed(w.install("xi").await.unwrap());
        // The user approves storage on the normal screen.
        sqlx::query("UPDATE tools SET approvals = '[\"storage\"]' WHERE id = ?")
            .bind(&first.tool.id)
            .execute(&w.pool)
            .await
            .unwrap();

        // Version 1.1.0 now also calls the network.
        let upd = w.listed(tool(
            "xi",
            "1.1.0",
            "<script>localStorage.setItem('k','v'); fetch(\"https://api.test/new\")</script>",
        ));
        w.publish(&[w.listed(storing("xi", "1.0.0")), upd], 2, &[]);
        w.clock.store(NOW + DAY, Ordering::SeqCst);
        w.client.refresh(ID).await.unwrap();

        let c = w.client.catalogue(ID).await.unwrap();
        assert_eq!(c.apps[0].state, InstallState::UpdateAvailable);
        assert_eq!(c.apps[0].installed_version.as_deref(), Some("1.0.0"));

        let u = installed(w.install("xi").await.unwrap());
        assert!(
            !u.is_new_tool,
            "an update keeps the tool, and with it the origin and storage"
        );
        assert_eq!(u.tool.id, first.tool.id);
        assert_eq!(u.provenance.version, "1.1.0");
        assert_eq!(
            w.approvals().await,
            vec!["[\"storage\"]".to_string()],
            "the new network access is NOT approved by updating"
        );
        assert_eq!(w.tools().await, 1);
        assert_eq!(
            w.client.catalogue(ID).await.unwrap().apps[0].state,
            InstallState::Installed
        );
    }

    #[tokio::test]
    async fn an_older_version_cannot_replace_a_newer_one() {
        let w = World::new().await;
        w.publish(
            &[
                w.listed(plain("omicron", "1.0.0")),
                w.listed(plain("omicron", "1.1.0")),
            ],
            1,
            &[],
        );
        w.add().await;
        installed(w.install_version("omicron", "1.1.0").await.unwrap());
        let e = w.install_version("omicron", "1.0.0").await.unwrap_err();
        assert_eq!(e.code(), "bundle_refused");
        assert!(
            e.to_string().contains("cannot move an app backwards"),
            "{e}"
        );
        assert_eq!(w.versions().await, 1);
    }

    #[tokio::test]
    async fn installing_the_same_version_twice_changes_nothing() {
        let w = World::new().await;
        w.publish(&[w.listed(plain("pi", "1.0.0"))], 1, &[]);
        w.add().await;
        installed(w.install("pi").await.unwrap());
        let calls = w.mock.call_count();
        match w.install("pi").await.unwrap() {
            InstallOutcome::AlreadyInstalled { version } => assert_eq!(version, "1.0.0"),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            w.mock.call_count(),
            calls,
            "nothing is downloaded for what is already here"
        );
        assert_eq!((w.tools().await, w.versions().await), (1, 1));
        // And install-all reports it as such.
        let out = w.client.install_many(&w.dir, ID, None).await.unwrap();
        assert!(matches!(
            out[0].outcome,
            BatchOutcome::AlreadyInstalled { .. }
        ));
    }

    #[tokio::test]
    async fn the_same_version_with_different_contents_already_installed_is_refused() {
        let w = World::new().await;
        // The user loaded 1.0.0 of this app from a file earlier, with other contents.
        let local = w.listed(tool("rho", "1.0.0", "<p>the file I had</p>"));
        let local_json = local.bundle.clone();
        crate::commands::bundle::install_bundle_inner(
            &w.pool,
            &w.dir,
            &local_json,
            &w.client.anchors,
            NOW,
        )
        .await
        .unwrap();
        w.publish(&[w.listed(plain("rho", "1.0.0"))], 1, &[]);
        w.add().await;
        let e = w.install("rho").await.unwrap_err();
        assert_eq!(e.code(), "bundle_refused");
        assert!(e.to_string().contains("different contents"), "{e}");
        assert_eq!(w.versions().await, 1);
    }

    // ── The catalogue and the cache ───────────────────────────────────────────

    #[tokio::test]
    async fn the_catalogue_reports_install_state_per_app() {
        let w = World::new().await;
        w.publish(
            &[
                w.listed(plain("a", "1.0.0")),
                w.listed(plain("b", "1.0.0")),
                w.listed(plain("c", "1.0.0")),
            ],
            1,
            &[],
        );
        w.add().await;
        installed(w.install("b").await.unwrap());
        let c = w.client.catalogue(ID).await.unwrap();
        let state = |n: &str| {
            c.apps
                .iter()
                .find(|a| a.app_id == format!("sh.test.{n}"))
                .unwrap()
                .state
        };
        assert_eq!(state("a"), InstallState::NotInstalled);
        assert_eq!(state("b"), InstallState::Installed);
        assert_eq!(c.registry_name, "Test Registry");
        assert!(!c.stale);
        // Serialises for the interface.
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["apps"][0]["state"], "notInstalled");
        assert!(v["apps"][0]["versions"][0]["declared"].is_array());
    }

    #[tokio::test]
    async fn installing_works_offline_from_the_cache_and_notes_a_stale_catalogue() {
        let w = World::new().await;
        w.publish(&[w.listed(plain("sigma", "1.0.0"))], 1, &[]);
        w.add().await;
        w.clock.store(NOW + 100 * DAY, Ordering::SeqCst);
        // Make a fresh bundle certificate check pass at the later date.
        let o = w.install("sigma").await.unwrap();
        match o {
            InstallOutcome::Installed { notes, .. } => {
                assert!(
                    notes.iter().any(|n| n.contains("catalogue is out of date")),
                    "{notes:?}"
                );
                assert!(
                    notes.iter().any(|n| n.contains("revocation list")),
                    "{notes:?}"
                );
            }
            other => panic!("{other:?}"),
        }
        let c = w.client.catalogue(ID).await.unwrap();
        assert!(c.stale && c.revocations_stale);
    }

    #[tokio::test]
    async fn a_modified_cache_stops_installs_and_the_catalogue() {
        let w = World::new().await;
        w.publish(&[w.listed(plain("tau", "1.0.0"))], 1, &[]);
        w.add().await;
        let row = super::super::store::get(&w.pool, ID)
            .await
            .unwrap()
            .unwrap();
        let mut bad = row.index_json.clone();
        let i = bad.len() / 2;
        bad[i] ^= 1;
        sqlx::query("UPDATE registries SET index_json = ? WHERE id = ?")
            .bind(bad)
            .bind(ID)
            .execute(&w.pool)
            .await
            .unwrap();
        assert!(w.install("tau").await.is_err());
        assert!(w.client.catalogue(ID).await.is_err());
        assert_eq!(w.tools().await, 0);
    }

    #[tokio::test]
    async fn one_failure_in_install_all_does_not_stop_the_others() {
        let w = World::new().await;
        let good1 = w.listed(plain("u1", "1.0.0"));
        let bad = w.listed(plain("u2", "1.0.0"));
        let good2 = w.listed(plain("u3", "1.0.0"));
        w.publish(&[good1, bad.clone(), good2], 1, &[]);
        w.add().await;
        let mut corrupt = bad.bundle.clone().into_bytes();
        corrupt[10] ^= 1;
        w.mock
            .serve(&format!("{BASE}bundles/sh.test.u2-1.0.0.sanctum"), &corrupt);
        let out = w.client.install_many(&w.dir, ID, None).await.unwrap();
        let ok = |n: &str| {
            matches!(
                out.iter()
                    .find(|i| i.app_id == format!("sh.test.{n}"))
                    .unwrap()
                    .outcome,
                BatchOutcome::Installed { .. }
            )
        };
        assert!(ok("u1") && ok("u3"));
        assert!(matches!(
            &out.iter().find(|i| i.app_id == "sh.test.u2").unwrap().outcome,
            BatchOutcome::Failed { code, .. } if code == "hash_mismatch" || code == "size_mismatch"
        ));
        assert_eq!(w.tools().await, 2);
    }

    #[tokio::test]
    async fn install_many_can_be_limited_to_chosen_apps() {
        let w = World::new().await;
        w.publish(
            &[
                w.listed(plain("v1", "1.0.0")),
                w.listed(plain("v2", "1.0.0")),
            ],
            1,
            &[],
        );
        w.add().await;
        let chosen = vec!["sh.test.v2".to_string()];
        let out = w
            .client
            .install_many(&w.dir, ID, Some(&chosen))
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(w.tools().await, 1);
    }

    /// The real site, real HTTPS, the real Enigma root: add the registry and install Shamir.
    /// Needs a network: `cargo test --lib live_site -- --ignored`.
    #[tokio::test]
    #[ignore = "needs network access to sanctum.enigma.sh"]
    async fn live_site_install_of_a_real_signed_bundle() {
        let dir =
            std::env::temp_dir().join(format!("sanctum-live-install-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        let pool = crate::db::create_pool(&dir).await.unwrap();
        crate::db::run_migrations(&pool).await.unwrap();
        let client = RegistryClient::production(pool.clone()).unwrap();
        let reg = client
            .add("https://sanctum.enigma.sh/registry/v1/", None)
            .await
            .unwrap();
        let first = client
            .install(&dir, &reg.id, "sh.enigma.shamir", None)
            .await
            .unwrap();
        let i = installed(first);
        assert_eq!(i.provenance.trust, "verified");
        assert_eq!(
            i.provenance.publisher_name.as_deref(),
            Some("Enigma Technologies Solutions")
        );
        assert!(i.tool.approvals.is_empty());
        // The library name comes from the file's own title, not from the registry or the
        // signature, so it can differ from the catalogue name.
        assert!(!i.tool.name.is_empty() && i.tool.name != "Unnamed Tool");
        assert!(matches!(
            client
                .install(&dir, &reg.id, "sh.enigma.shamir", None)
                .await
                .unwrap(),
            InstallOutcome::AlreadyInstalled { .. }
        ));
        let c = client.catalogue(&reg.id).await.unwrap();
        let shamir = c
            .apps
            .iter()
            .find(|a| a.app_id == "sh.enigma.shamir")
            .unwrap();
        assert_eq!(shamir.state, InstallState::Installed);
    }

    #[tokio::test]
    async fn outcomes_serialise_for_the_interface() {
        let w = World::new().await;
        w.publish(&[w.listed(plain("w1", "1.0.0"))], 1, &[]);
        w.add().await;
        let v = serde_json::to_value(w.install("w1").await.unwrap()).unwrap();
        assert_eq!(v["state"], "installed");
        assert_eq!(v["install"]["provenance"]["trust"], "verified");
        let v = serde_json::to_value(w.install("w1").await.unwrap()).unwrap();
        assert_eq!(v["state"], "alreadyInstalled");
        let out = w.client.install_many(&w.dir, ID, None).await.unwrap();
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v[0]["appId"], "sh.test.w1");
        assert_eq!(v[0]["state"], "alreadyInstalled");
    }
}
