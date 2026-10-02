// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Install a tool from a signed `.sanctum` bundle.
//!
//! A bundle changes where a tool comes from and what we can say about who published it.
//! It does not change what the tool may do: the HTML goes through the same scan, is stored
//! under the same hash, runs under the same CSP, and starts with no approvals. The one extra
//! gate is that the scan must find nothing the publisher did not declare.

use std::path::Path;

use sanctum_bundle::{
    compare_versions, parse_bundle, parse_version, verify, Anchor, Trust, VerifyError,
};
use serde::Serialize;
use sqlx::Row;
use tauri::command;

use crate::commands::ingest::{ingest_html_inner, load_tool_record};
use crate::commands::scan::scan_html;
use crate::commands::versioning::create_version_inner;
use crate::db::DbState;
pub use crate::models::ProvenanceRecord;
use crate::models::{DetectedCapability, ToolRecord, VersionRecord};
use crate::AppDataDir;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInstall {
    pub tool: ToolRecord,
    pub version: VersionRecord,
    pub is_new_tool: bool,
    pub provenance: ProvenanceRecord,
    /// Things worth telling the user that did not stop the install.
    pub warnings: Vec<String>,
}

/// Capabilities the scan found that the publisher did not declare.
///
/// Declared-but-unused is fine (the scan is advisory and publishers may over-declare).
/// Detected-but-undeclared is not: either the declaration is wrong or the file is not what
/// the publisher meant to sign.
pub fn undeclared(detected: &[DetectedCapability], declared: &[DetectedCapability]) -> Vec<String> {
    let union = |pick: fn(&DetectedCapability) -> Option<&Vec<String>>| -> Option<Vec<&String>> {
        let mut any = false;
        let mut all = Vec::new();
        for d in declared {
            if let Some(v) = pick(d) {
                any = true;
                all.extend(v.iter());
            }
        }
        any.then_some(all)
    };
    let net = union(|c| match c {
        DetectedCapability::Net(n) => Some(&n.net),
        _ => None,
    });
    let card = union(|c| match c {
        DetectedCapability::Smartcard(s) => Some(&s.smartcard),
        _ => None,
    });

    detected
        .iter()
        .filter(|cap| match cap {
            DetectedCapability::Feature(_) => !declared.contains(cap),
            DetectedCapability::Net(n) => match &net {
                None => true,
                Some(all) => !n.net.iter().all(|h| all.contains(&h)),
            },
            DetectedCapability::Smartcard(s) => match &card {
                None => true,
                Some(all) => !s.smartcard.iter().all(|a| all.contains(&a)),
            },
        })
        .map(|c| c.to_plain_language())
        .collect()
}

fn parse_declared(raw: &[serde_json::Value]) -> Result<Vec<DetectedCapability>, String> {
    raw.iter()
        .map(|v| {
            serde_json::from_value::<DetectedCapability>(v.clone())
                .map_err(|e| format!("Bundle declares an unrecognised capability ({v}): {e}"))
        })
        .collect()
}

fn verify_message(e: VerifyError) -> String {
    match e {
        VerifyError::BadSignature | VerifyError::ChecksumMismatch { .. } => format!(
            "Refusing to install: {e}. The file was altered after it was signed, or it is not a genuine bundle."
        ),
        other => format!("Refusing to install: {other}."),
    }
}

async fn provenance_versions(
    pool: &sqlx::SqlitePool,
    app_id: &str,
) -> Result<Vec<(String, String)>, String> {
    let rows = sqlx::query("SELECT version_id, version FROM bundle_provenance WHERE app_id = $1")
        .bind(app_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    rows.iter()
        .map(|r| {
            Ok((
                r.try_get::<String, _>("version_id")
                    .map_err(|e| e.to_string())?,
                r.try_get::<String, _>("version")
                    .map_err(|e| e.to_string())?,
            ))
        })
        .collect()
}

/// Verify a bundle and install it. `anchors` and `now` are parameters so tests can supply
/// their own; the command passes the compiled-in anchors and the wall clock.
pub async fn install_bundle_inner(
    pool: &sqlx::SqlitePool,
    data_dir: &Path,
    bundle_json: &str,
    anchors: &[Anchor],
    now: i64,
) -> Result<BundleInstall, String> {
    // 1. Signature, hash, and who signed. Nothing is written before this passes.
    let bundle = parse_bundle(bundle_json).map_err(verify_message)?;
    let v = verify(&bundle, anchors, now).map_err(verify_message)?;
    let st = &v.statement;
    let html = bundle.html.as_str();

    // 2. The local scan must agree with the declaration. The scan runs on the bytes, exactly
    //    as for a loose file; nothing about the signature changes what it finds.
    let declared = parse_declared(&st.declared)?;
    let missing = undeclared(&scan_html(html), &declared);
    if !missing.is_empty() {
        return Err(format!(
            "Refusing to install: the file uses capabilities the publisher did not declare: {}.",
            missing.join("; ")
        ));
    }

    // 3. App identity and downgrade protection.
    let new_ver = parse_version(&st.version).ok_or("Bundle version is invalid")?;
    let sha_hex = st.checksum.trim_start_matches("sha256:").to_string();
    let mut warnings = Vec::new();

    let by_app = sqlx::query("SELECT id FROM tools WHERE app_id = $1")
        .bind(&st.app_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut known_tool: Option<String> = match by_app {
        Some(r) => Some(r.try_get("id").map_err(|e| e.to_string())?),
        None => None,
    };

    if known_tool.is_some() {
        for (version_id, installed) in provenance_versions(pool, &st.app_id).await? {
            let Some(old) = parse_version(&installed) else {
                continue;
            };
            match compare_versions(&new_ver, &old) {
                std::cmp::Ordering::Less => {
                    return Err(format!(
                        "Refusing to install {} {}: version {} is already installed. Bundles cannot move an app backwards; use Roll back on the tool if you mean to.",
                        st.name, st.version, installed
                    ));
                }
                std::cmp::Ordering::Equal if version_id != sha_hex => {
                    return Err(format!(
                        "Refusing to install: version {} of {} is already installed with different contents.",
                        installed, st.name
                    ));
                }
                _ => {}
            }
        }
    } else {
        // Same bytes may already be in the library as a loose file. Adopt that tool rather
        // than fail on the content-addressed primary key, unless it belongs to another app.
        if let Some(r) = sqlx::query(
            "SELECT t.id AS id, t.app_id AS app_id
             FROM tool_versions v JOIN tools t ON t.id = v.tool_id WHERE v.id = $1",
        )
        .bind(&sha_hex)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        {
            let other: Option<String> = r.try_get("app_id").unwrap_or(None);
            if let Some(other) = other {
                return Err(format!(
                    "Refusing to install: these exact bytes are already installed as a different app ({other})."
                ));
            }
            known_tool = Some(r.try_get("id").map_err(|e| e.to_string())?);
            warnings.push(
                "This file was already in your library; it now carries the publisher's signature."
                    .into(),
            );
        }
    }

    // 4. Store. Same code path as a loose file, so the hash, manifest and scan are identical.
    let (tool_id, version, is_new_tool) = match known_tool {
        Some(tid) => {
            let ver = create_version_inner(pool, data_dir, &tid, html).await?;
            (tid, ver, false)
        }
        None => {
            // Display name comes from the file itself, as for a loose file: a publisher
            // that nobody vouches for does not get to choose what the library calls it.
            let r = ingest_html_inner(pool, data_dir, html, None).await?;
            (r.tool.id, r.version, true)
        }
    };
    if version.id != sha_hex {
        return Err("Internal error: stored hash differs from the signed checksum".into());
    }

    sqlx::query("UPDATE tools SET app_id = $1 WHERE id = $2")
        .bind(&st.app_id)
        .bind(&tool_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    // 5. Record provenance next to the version.
    let (trust, publisher_name) = match &v.trust {
        Trust::Anchored { publisher } => ("verified", Some(publisher.clone())),
        Trust::Unanchored { reason } => {
            if let Some(r) = reason {
                warnings.push(format!("Publisher could not be confirmed: {r}."));
            }
            ("unknown_signer", None)
        }
    };
    let installed_at = chrono::Utc::now().timestamp_millis();
    let statement_json = serde_json::to_string(st).map_err(|e| e.to_string())?;
    let signature_json = serde_json::to_string(&bundle.signature).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO bundle_provenance
         (version_id, app_id, publisher_key, publisher_name, trust, name, version,
          statement, signature, issued_at, installed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(version_id) DO UPDATE SET
           publisher_key = excluded.publisher_key, publisher_name = excluded.publisher_name,
           trust = excluded.trust, statement = excluded.statement,
           signature = excluded.signature, installed_at = excluded.installed_at",
    )
    .bind(&version.id)
    .bind(&st.app_id)
    .bind(&v.signer_key)
    .bind(&publisher_name)
    .bind(trust)
    .bind(&st.name)
    .bind(&st.version)
    .bind(&statement_json)
    .bind(&signature_json)
    .bind(st.issued_at)
    .bind(installed_at)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(BundleInstall {
        tool: load_tool_record(pool, &tool_id).await?,
        provenance: ProvenanceRecord {
            version_id: version.id.clone(),
            app_id: st.app_id.clone(),
            publisher_key: v.signer_key,
            publisher_name,
            trust: trust.into(),
            name: st.name.clone(),
            version: st.version.clone(),
            issued_at: st.issued_at,
            installed_at,
        },
        version,
        is_new_tool,
        warnings,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Install a `.sanctum` bundle from a file path.
#[command]
pub async fn ingest_bundle_from_path(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
    path: String,
) -> Result<BundleInstall, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Cannot read file '{path}': {e}"))?;
    if meta.len() as usize > sanctum_bundle::MAX_BUNDLE_BYTES {
        return Err("Bundle is too large".into());
    }
    let json =
        std::fs::read_to_string(&path).map_err(|e| format!("Cannot read file '{path}': {e}"))?;
    install_bundle_inner(
        &db.0,
        &data_dir.0,
        &json,
        &crate::trust::production_anchors(),
        chrono::Utc::now().timestamp(),
    )
    .await
}

/// Provenance for a specific version, if it came from a signed bundle.
pub async fn load_provenance(
    pool: &sqlx::SqlitePool,
    version_id: &str,
) -> Option<ProvenanceRecord> {
    let r = sqlx::query("SELECT * FROM bundle_provenance WHERE version_id = $1")
        .bind(version_id)
        .fetch_optional(pool)
        .await
        .ok()??;
    Some(ProvenanceRecord {
        version_id: r.try_get("version_id").unwrap_or_default(),
        app_id: r.try_get("app_id").unwrap_or_default(),
        publisher_key: r.try_get("publisher_key").unwrap_or_default(),
        publisher_name: r.try_get("publisher_name").unwrap_or(None),
        trust: r.try_get("trust").unwrap_or_default(),
        name: r.try_get("name").unwrap_or_default(),
        version: r.try_get("version").unwrap_or_default(),
        issued_at: r.try_get("issued_at").unwrap_or(0),
        installed_at: r.try_get("installed_at").unwrap_or(0),
    })
}

#[command]
pub async fn get_provenance(
    db: tauri::State<'_, DbState>,
    version_id: String,
) -> Result<Option<ProvenanceRecord>, String> {
    Ok(load_provenance(&db.0, &version_id).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CapabilityFeature, NetCapability, SmartcardCapability};
    use ed25519_dalek::SigningKey;
    use rand_core::OsRng;
    use sanctum_bundle::{issue_certificate, key_id, sign_bundle, Certificate, StatementInput};

    const NOW: i64 = 1_790_000_000;
    const APP: &str = "sh.enigma.test-tool";

    fn feat(f: CapabilityFeature) -> DetectedCapability {
        DetectedCapability::Feature(f)
    }
    fn net(h: &[&str]) -> DetectedCapability {
        DetectedCapability::Net(NetCapability {
            net: h.iter().map(|s| s.to_string()).collect(),
        })
    }
    fn card(a: &[&str]) -> DetectedCapability {
        DetectedCapability::Smartcard(SmartcardCapability {
            smartcard: a.iter().map(|s| s.to_string()).collect(),
        })
    }

    // ── undeclared(): the declared-vs-detected rule ──────────────────────────

    #[test]
    fn nothing_detected_needs_nothing_declared() {
        assert!(undeclared(&[], &[]).is_empty());
    }

    #[test]
    fn over_declaring_is_allowed() {
        let declared = [
            feat(CapabilityFeature::Storage),
            feat(CapabilityFeature::Camera),
        ];
        assert!(undeclared(&[feat(CapabilityFeature::Storage)], &declared).is_empty());
    }

    #[test]
    fn an_undeclared_feature_is_reported() {
        let m = undeclared(
            &[
                feat(CapabilityFeature::Storage),
                feat(CapabilityFeature::Camera),
            ],
            &[feat(CapabilityFeature::Storage)],
        );
        assert_eq!(m, vec!["use your camera"]);
    }

    #[test]
    fn net_hosts_must_be_a_subset_of_declared_hosts() {
        assert!(undeclared(&[net(&["a.com"])], &[net(&["a.com", "b.com"])]).is_empty());
        assert_eq!(
            undeclared(&[net(&["a.com", "evil.com"])], &[net(&["a.com"])]).len(),
            1
        );
        // Hosts spread across two declared entries are pooled.
        assert!(undeclared(
            &[net(&["a.com", "b.com"])],
            &[net(&["a.com"]), net(&["b.com"])]
        )
        .is_empty());
    }

    #[test]
    fn declaring_dynamic_does_not_cover_named_hosts_and_vice_versa() {
        assert_eq!(
            undeclared(&[net(&["a.com"])], &[net(&["(dynamic)"])]).len(),
            1
        );
        assert_eq!(
            undeclared(&[net(&["(dynamic)"])], &[net(&["a.com"])]).len(),
            1
        );
        assert!(undeclared(&[net(&["(dynamic)"])], &[net(&["(dynamic)"])]).is_empty());
    }

    #[test]
    fn any_net_use_needs_a_net_declaration() {
        assert_eq!(undeclared(&[net(&[])], &[]).len(), 1);
        assert_eq!(
            undeclared(&[net(&["a.com"])], &[feat(CapabilityFeature::Storage)]).len(),
            1
        );
    }

    #[test]
    fn smartcard_aids_follow_the_same_rule() {
        let oath = "a0000005272101";
        assert!(undeclared(&[card(&[oath])], &[card(&[oath, "a0000006472f0001"])]).is_empty());
        assert_eq!(
            undeclared(&[card(&[oath, "d27600012401"])], &[card(&[oath])]).len(),
            1
        );
        assert_eq!(undeclared(&[card(&[oath])], &[]).len(), 1);
    }

    // ── install_bundle_inner(): needs a real database ────────────────────────

    struct Env {
        pool: sqlx::SqlitePool,
        dir: std::path::PathBuf,
        root: SigningKey,
        publisher: SigningKey,
        anchors: Vec<Anchor>,
    }

    impl Env {
        async fn new() -> Env {
            let dir =
                std::env::temp_dir().join(format!("sanctum-bundle-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let pool = crate::db::create_pool(&dir).await.unwrap();
            crate::db::run_migrations(&pool).await.unwrap();
            let root = SigningKey::generate(&mut OsRng);
            let publisher = SigningKey::generate(&mut OsRng);
            let anchors = vec![Anchor {
                key: root.verifying_key(),
                name: "Test Root".into(),
            }];
            Env {
                pool,
                dir,
                root,
                publisher,
                anchors,
            }
        }

        fn cert(&self) -> sanctum_bundle::SignedBlob {
            issue_certificate(
                &self.root,
                &Certificate {
                    schema: 1,
                    subject: key_id(&self.publisher.verifying_key()),
                    name: "Test Publisher".into(),
                    not_before: NOW - 10,
                    not_after: NOW + 10,
                    scope: vec!["sh.enigma.".into()],
                },
            )
            .unwrap()
        }

        fn bundle(
            &self,
            html: &str,
            version: &str,
            declared: Vec<serde_json::Value>,
            sign_with_cert: bool,
        ) -> String {
            let b = sign_bundle(
                html,
                StatementInput {
                    app_id: APP.into(),
                    name: "Test Tool".into(),
                    version: version.into(),
                    declared,
                    issued_at: NOW,
                },
                &self.publisher,
                sign_with_cert.then(|| self.cert()),
            )
            .unwrap();
            serde_json::to_string(&b).unwrap()
        }

        async fn install(&self, json: &str) -> Result<BundleInstall, String> {
            install_bundle_inner(&self.pool, &self.dir, json, &self.anchors, NOW).await
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn page(body: &str) -> String {
        format!("<!doctype html><title>Test Tool</title><body>{body}")
    }

    fn storage() -> Vec<serde_json::Value> {
        vec![serde_json::json!("storage")]
    }

    #[tokio::test]
    async fn verified_install_records_provenance_and_grants_nothing() {
        let env = Env::new().await;
        let html = page("<script>localStorage.setItem('a','b')</script>");
        let r = env
            .install(&env.bundle(&html, "1.0.0", storage(), true))
            .await
            .unwrap();
        assert!(r.is_new_tool);
        assert_eq!(r.provenance.trust, "verified");
        assert_eq!(
            r.provenance.publisher_name.as_deref(),
            Some("Test Publisher")
        );
        // Rule 1: a signature approves nothing.
        assert!(r.tool.approvals.is_empty());
        assert_eq!(
            r.version.id,
            crate::commands::versioning::hash_bytes_hex(html.as_bytes())
        );
    }

    #[tokio::test]
    async fn unknown_signer_installs_as_unknown_with_the_same_power() {
        let env = Env::new().await;
        let html = page("hello");
        let r = env
            .install(&env.bundle(&html, "1.0.0", vec![], false))
            .await
            .unwrap();
        assert_eq!(r.provenance.trust, "unknown_signer");
        assert!(r.provenance.publisher_name.is_none());
        assert!(r.tool.approvals.is_empty());
    }

    #[tokio::test]
    async fn undeclared_capability_is_refused_and_nothing_is_written() {
        let env = Env::new().await;
        // Uses the camera but declares only storage.
        let html = page(
            "<script>navigator.mediaDevices.getUserMedia({video:true});localStorage.x=1</script>",
        );
        let err = env
            .install(&env.bundle(&html, "1.0.0", storage(), true))
            .await
            .unwrap_err();
        assert!(err.contains("did not declare"), "{err}");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tools")
            .fetch_one(&env.pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn tampered_html_is_refused() {
        let env = Env::new().await;
        let json = env.bundle(&page("one"), "1.0.0", vec![], true);
        let mut b: serde_json::Value = serde_json::from_str(&json).unwrap();
        b["html"] = serde_json::json!(page("two"));
        let err = env.install(&b.to_string()).await.unwrap_err();
        assert!(err.contains("altered"), "{err}");
    }

    #[tokio::test]
    async fn update_keeps_the_tool_and_therefore_its_storage() {
        let env = Env::new().await;
        let first = env
            .install(&env.bundle(&page("v1"), "1.0.0", vec![], true))
            .await
            .unwrap();
        let second = env
            .install(&env.bundle(&page("v2"), "1.1.0", vec![], true))
            .await
            .unwrap();
        assert!(!second.is_new_tool);
        assert_eq!(
            first.tool.id, second.tool.id,
            "tool id is the origin; it must not change"
        );
        assert_ne!(first.version.id, second.version.id);
        assert_eq!(second.version.version_num, 2);
    }

    #[tokio::test]
    async fn updates_do_not_inherit_new_capabilities() {
        let env = Env::new().await;
        let first = env
            .install(&env.bundle(&page("v1"), "1.0.0", vec![], true))
            .await
            .unwrap();
        // User approves storage on v1 (a no-op capability here, but it is an approval).
        sqlx::query("UPDATE tools SET approvals = $1 WHERE id = $2")
            .bind(serde_json::to_string(&[feat(CapabilityFeature::Storage)]).unwrap())
            .bind(&first.tool.id)
            .execute(&env.pool)
            .await
            .unwrap();
        let v2 = page("<script>navigator.clipboard.readText();localStorage.x=1</script>");
        let second = env
            .install(&env.bundle(&v2, "1.1.0", storage(), true))
            .await
            .unwrap();
        // Approvals are an explicit list; installing a version never edits it.
        assert_eq!(
            second.tool.approvals,
            vec![feat(CapabilityFeature::Storage)]
        );
    }

    #[tokio::test]
    async fn downgrade_is_refused() {
        let env = Env::new().await;
        env.install(&env.bundle(&page("v2"), "1.2.0", vec![], true))
            .await
            .unwrap();
        let err = env
            .install(&env.bundle(&page("v1"), "1.1.0", vec![], true))
            .await
            .unwrap_err();
        assert!(err.contains("already installed"), "{err}");
    }

    #[tokio::test]
    async fn reinstalling_the_same_bundle_is_a_no_op() {
        let env = Env::new().await;
        let json = env.bundle(&page("same"), "1.0.0", vec![], true);
        let a = env.install(&json).await.unwrap();
        let b = env.install(&json).await.unwrap();
        assert_eq!(a.tool.id, b.tool.id);
        assert_eq!(b.version.version_num, 1);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bundle_provenance")
            .fetch_one(&env.pool)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn same_version_with_different_bytes_is_refused() {
        let env = Env::new().await;
        env.install(&env.bundle(&page("a"), "1.0.0", vec![], true))
            .await
            .unwrap();
        let err = env
            .install(&env.bundle(&page("b"), "1.0.0", vec![], true))
            .await
            .unwrap_err();
        assert!(err.contains("different contents"), "{err}");
    }

    #[tokio::test]
    async fn a_loose_copy_is_adopted_not_duplicated() {
        let env = Env::new().await;
        let html = page("loose first");
        let loose = ingest_html_inner(&env.pool, &env.dir, &html, None)
            .await
            .unwrap();
        let r = env
            .install(&env.bundle(&html, "1.0.0", vec![], true))
            .await
            .unwrap();
        assert!(!r.is_new_tool);
        assert_eq!(r.tool.id, loose.tool.id);
        assert!(!r.warnings.is_empty());
    }

    #[tokio::test]
    async fn bytes_owned_by_another_app_are_refused() {
        let env = Env::new().await;
        let html = page("shared");
        env.install(&env.bundle(&html, "1.0.0", vec![], true))
            .await
            .unwrap();
        // Same bytes, different app_id.
        let b = sign_bundle(
            &html,
            StatementInput {
                app_id: "sh.enigma.other".into(),
                name: "Other".into(),
                version: "1.0.0".into(),
                declared: vec![],
                issued_at: NOW,
            },
            &env.publisher,
            Some(env.cert()),
        )
        .unwrap();
        let err = env
            .install(&serde_json::to_string(&b).unwrap())
            .await
            .unwrap_err();
        assert!(err.contains("different app"), "{err}");
    }

    /// The OTP vault example, signed with the declaration the signing script would
    /// produce (`scan_declared`), installs, and the approval screen is still what the
    /// README says: nothing is approved until the user approves it.
    #[tokio::test]
    async fn the_otp_vault_example_installs_from_a_bundle() {
        let env = Env::new().await;
        let html = include_str!("../../../examples/otp-vault/index.html");
        let declared = vec![
            serde_json::json!("storage"),
            serde_json::json!({"smartcard": ["a0000005272101"]}),
        ];
        let r = env
            .install(&env.bundle(html, "1.0.0", declared, true))
            .await
            .unwrap();
        assert_eq!(r.provenance.trust, "verified");
        assert!(r.tool.approvals.is_empty());
        // Declaring only storage must not be enough for this file.
        let env2 = Env::new().await;
        let err = env2
            .install(&env2.bundle(html, "1.0.0", storage(), true))
            .await
            .unwrap_err();
        assert!(err.contains("smart card"), "{err}");
    }

    #[tokio::test]
    async fn display_name_comes_from_the_file_not_the_statement() {
        let env = Env::new().await;
        let html = "<!doctype html><title>Plain Title</title>x".to_string();
        let b = sign_bundle(
            &html,
            StatementInput {
                app_id: APP.into(),
                name: "Enigma Official Vault".into(),
                version: "1.0.0".into(),
                declared: vec![],
                issued_at: NOW,
            },
            &env.publisher,
            None,
        )
        .unwrap();
        let r = env
            .install(&serde_json::to_string(&b).unwrap())
            .await
            .unwrap();
        assert_eq!(r.tool.name, "Plain Title");
    }
}
