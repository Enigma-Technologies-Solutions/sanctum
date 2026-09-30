// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Organisation policy, stage 2a: `pinned_checksums`.
//!
//! An administrator drops a read-only `policy.json` at a system path. When it lists
//! `pinned_checksums`, only a tool whose exact SHA-256 is on the list may run. It needs no
//! keys, no registry and no signing, which is why it comes first (see `docs/registry.md`).
//!
//! Three rules shape this file:
//!
//! 1. **Fail closed.** A policy file that exists but cannot be trusted (unreadable, bad JSON,
//!    unknown field, newer schema, wrong owner, bad hash) blocks every tool launch with a
//!    message saying why. Ignoring a broken policy would turn a typo into "no enforcement".
//!    No file at all means no policy, and Sanctum behaves exactly as before.
//! 2. **Unknown fields are errors.** A control this build does not understand must not be
//!    silently skipped by an older client.
//! 3. **The pin is checked against the hash that just passed the integrity check**, not a
//!    value read from the database, so a swapped file cannot borrow a pinned hash.
//!
//! The policy only ever narrows what runs. It never grants a capability.
//!
//! Full policy (`block_unsigned`, `grants`, registry allow-lists) is stage 2b.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SUPPORTED_SCHEMA: u32 = 1;
const MAX_POLICY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub schema_version: u32,
    /// `sha256:<64 hex>` values. `None` means this control is not in use. `Some(vec![])`
    /// means nothing may run, which is a deliberate way to lock a machine down.
    #[serde(default)]
    pub pinned_checksums: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyState {
    /// No policy file. Sanctum runs as it always has.
    Absent,
    Active(Policy),
    /// A policy file exists but cannot be trusted. Launches are blocked.
    Invalid(String),
}

/// Where the administrator-managed policy lives. Deliberately not configurable by
/// environment variable or flag: a setting the user controls is not an org policy.
pub fn policy_path() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(PathBuf::from(
            "/Library/Application Support/Sanctum/policy.json",
        ))
    }
    #[cfg(target_os = "linux")]
    {
        Some(PathBuf::from("/etc/sanctum/policy.json"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("ProgramData")
            .map(|p| PathBuf::from(p).join("Sanctum").join("policy.json"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

/// Load the system policy. Read on every launch so a change takes effect without a restart.
pub fn load() -> PolicyState {
    match policy_path() {
        Some(p) => load_from(&p, true),
        None => PolicyState::Absent,
    }
}

/// `require_admin_owned`: on Unix, refuse a policy that is not owned by root or that group
/// or others can write. Tests turn it off because they write into a temp directory.
/// On Windows the protection is the ACL on `%ProgramData%\Sanctum`; Sanctum does not
/// inspect it, which is a known gap (see `docs/policy.md`).
pub fn load_from(path: &Path, require_admin_owned: bool) -> PolicyState {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return PolicyState::Absent,
        Err(e) => return invalid(path, format!("cannot be read ({e})")),
    };
    if !meta.file_type().is_file() {
        return invalid(path, "is not a regular file".into());
    }
    if meta.len() > MAX_POLICY_BYTES {
        return invalid(path, "is too large".into());
    }
    #[cfg(unix)]
    if require_admin_owned {
        use std::os::unix::fs::MetadataExt;
        if let Some(why) = ownership_problem(meta.uid(), meta.mode()) {
            return invalid(path, why.into());
        }
    }
    #[cfg(not(unix))]
    let _ = require_admin_owned;

    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => return invalid(path, format!("cannot be read ({e})")),
    };
    parse(&text).map_or_else(|why| invalid(path, why), PolicyState::Active)
}

/// Why a policy file with this owner and mode cannot be trusted as admin-managed, if so.
/// Pure so the rule is testable without creating root-owned files.
#[cfg(unix)]
fn ownership_problem(uid: u32, mode: u32) -> Option<&'static str> {
    if uid != 0 {
        Some("is not owned by root")
    } else if mode & 0o022 != 0 {
        Some("is writable by group or others")
    } else {
        None
    }
}

fn invalid(path: &Path, why: String) -> PolicyState {
    PolicyState::Invalid(format!("The policy file {} {why}.", path.display()))
}

pub fn parse(text: &str) -> Result<Policy, String> {
    let policy: Policy =
        serde_json::from_str(text).map_err(|e| format!("is not a valid policy ({e})"))?;
    if policy.schema_version != SUPPORTED_SCHEMA {
        return Err(format!(
            "uses schema version {}, but this Sanctum understands version {SUPPORTED_SCHEMA}; update Sanctum",
            policy.schema_version
        ));
    }
    if let Some(list) = &policy.pinned_checksums {
        for entry in list {
            if normalise(entry).is_none() {
                return Err(format!(
                    "has an invalid entry in pinned_checksums ({entry:?}); expected sha256: followed by 64 hex digits"
                ));
            }
        }
    }
    Ok(policy)
}

/// `sha256:<64 hex>` (any case) to lowercase hex, or `None` if malformed.
fn normalise(entry: &str) -> Option<String> {
    let hex = entry.trim().strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_lowercase())
}

/// May a tool whose verified SHA-256 is `sha_hex` (bare hex) run under this policy?
pub fn check_run(state: &PolicyState, sha_hex: &str) -> Result<(), String> {
    match state {
        PolicyState::Absent => Ok(()),
        PolicyState::Invalid(why) => Err(format!(
            "Your organisation's policy could not be applied, so tools are blocked. {why}"
        )),
        PolicyState::Active(p) => match &p.pinned_checksums {
            None => Ok(()),
            Some(list) => {
                let want = sha_hex.to_ascii_lowercase();
                if list.iter().filter_map(|e| normalise(e)).any(|h| h == want) {
                    Ok(())
                } else {
                    Err(format!(
                        "Your organisation's policy only allows approved tools, and this version (sha256:{sha_hex}) is not on the list."
                    ))
                }
            }
        },
    }
}

// ── Status for the UI ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyStatus {
    /// A policy file is present, valid or not.
    pub managed: bool,
    /// Number of pinned checksums, when pinning is in use.
    pub pinned_count: Option<usize>,
    /// Why the policy cannot be applied. Launches are blocked while this is set.
    pub error: Option<String>,
}

pub fn status(state: &PolicyState) -> PolicyStatus {
    match state {
        PolicyState::Absent => PolicyStatus {
            managed: false,
            pinned_count: None,
            error: None,
        },
        PolicyState::Active(p) => PolicyStatus {
            managed: true,
            pinned_count: p.pinned_checksums.as_ref().map(|l| l.len()),
            error: None,
        },
        PolicyState::Invalid(why) => PolicyStatus {
            managed: true,
            pinned_count: None,
            error: Some(why.clone()),
        },
    }
}

#[tauri::command]
pub fn get_policy_status() -> PolicyStatus {
    status(&load())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "1175b0ac0a575996e035ff33543617585d63b2e544d8e493543ce6b3a37adb36";
    const B: &str = "7875f67e8c63f256db29e0c76eebeb23f67fd843a0dff8b88dc2750d6bf73079";

    fn active(list: Option<Vec<&str>>) -> PolicyState {
        PolicyState::Active(Policy {
            schema_version: 1,
            pinned_checksums: list.map(|l| l.into_iter().map(String::from).collect()),
        })
    }

    fn tmp(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sanctum-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn no_policy_means_no_restriction() {
        assert!(check_run(&PolicyState::Absent, A).is_ok());
    }

    #[test]
    fn a_policy_without_pins_restricts_nothing() {
        assert!(check_run(&active(None), A).is_ok());
    }

    #[test]
    fn a_pinned_hash_runs_and_others_do_not() {
        let s = active(Some(vec![&format!("sha256:{A}")]));
        assert!(check_run(&s, A).is_ok());
        let err = check_run(&s, B).unwrap_err();
        assert!(err.contains("not on the list"), "{err}");
    }

    #[test]
    fn an_empty_pin_list_blocks_everything() {
        assert!(check_run(&active(Some(vec![])), A).is_err());
    }

    #[test]
    fn hash_case_does_not_matter() {
        let s = active(Some(vec![&format!("sha256:{}", A.to_uppercase())]));
        assert!(check_run(&s, A).is_ok());
        assert!(check_run(&s, &A.to_uppercase()).is_ok());
    }

    #[test]
    fn a_prefix_or_extension_of_a_pinned_hash_is_not_a_match() {
        let s = active(Some(vec![&format!("sha256:{A}")]));
        assert!(check_run(&s, &A[..63]).is_err());
        assert!(check_run(&s, &format!("{A}0")).is_err());
        assert!(check_run(&s, "").is_err());
    }

    #[test]
    fn an_invalid_policy_blocks_with_the_reason() {
        let s = PolicyState::Invalid("The policy file /x is not valid.".into());
        let err = check_run(&s, A).unwrap_err();
        assert!(err.contains("blocked") && err.contains("/x"), "{err}");
    }

    #[test]
    fn parse_accepts_the_documented_shape() {
        let p = parse(&format!(
            r#"{{"schema_version":1,"pinned_checksums":["sha256:{A}"]}}"#
        ))
        .unwrap();
        assert_eq!(p.pinned_checksums.unwrap().len(), 1);
        assert!(parse(r#"{"schema_version":1}"#)
            .unwrap()
            .pinned_checksums
            .is_none());
    }

    #[test]
    fn parse_rejects_what_it_does_not_understand() {
        // A newer control an old client would otherwise skip.
        assert!(parse(r#"{"schema_version":1,"block_unsigned":true}"#).is_err());
        // Newer schema.
        assert!(parse(r#"{"schema_version":2}"#)
            .unwrap_err()
            .contains("update Sanctum"));
        // Not JSON, wrong types, malformed hashes.
        assert!(parse("pinned: yes").is_err());
        assert!(parse(r#"{"schema_version":"1"}"#).is_err());
        assert!(parse(r#"{"schema_version":1,"pinned_checksums":["abc"]}"#).is_err());
        assert!(parse(&format!(
            r#"{{"schema_version":1,"pinned_checksums":["{A}"]}}"#
        ))
        .is_err());
        assert!(parse(r#"{"schema_version":1,"pinned_checksums":["sha256:zz"]}"#).is_err());
    }

    #[test]
    fn a_missing_file_is_absent_not_invalid() {
        let p = std::env::temp_dir().join(format!("nope-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_from(&p, false), PolicyState::Absent);
    }

    #[test]
    fn a_broken_file_is_invalid_not_absent() {
        let p = tmp("policy.json", "{ nope");
        assert!(matches!(load_from(&p, false), PolicyState::Invalid(_)));
    }

    #[test]
    fn a_good_file_loads() {
        let p = tmp(
            "policy.json",
            &format!(r#"{{"schema_version":1,"pinned_checksums":["sha256:{A}"]}}"#),
        );
        assert!(matches!(load_from(&p, false), PolicyState::Active(_)));
    }

    #[test]
    fn a_directory_is_invalid() {
        let p = tmp("policy.json", "x");
        assert!(matches!(
            load_from(p.parent().unwrap(), false),
            PolicyState::Invalid(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_invalid() {
        let target = tmp("real.json", r#"{"schema_version":1}"#);
        let link = target.with_file_name("policy.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(matches!(load_from(&link, false), PolicyState::Invalid(_)));
    }

    #[cfg(unix)]
    #[test]
    fn a_file_the_user_owns_is_rejected_when_admin_ownership_is_required() {
        use std::os::unix::fs::MetadataExt;
        let p = tmp("policy.json", r#"{"schema_version":1}"#);
        if std::fs::metadata(&p).unwrap().uid() == 0 {
            return; // running as root: the file is root-owned, nothing to reject
        }
        match load_from(&p, true) {
            PolicyState::Invalid(why) => assert!(why.contains("not owned by root"), "{why}"),
            other => panic!("expected Invalid, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn ownership_rule() {
        assert_eq!(ownership_problem(0, 0o644), None);
        assert_eq!(ownership_problem(0, 0o600), None);
        assert!(ownership_problem(501, 0o644)
            .unwrap()
            .contains("not owned by root"));
        assert!(ownership_problem(0, 0o664).unwrap().contains("writable"));
        assert!(ownership_problem(0, 0o646).unwrap().contains("writable"));
        assert!(ownership_problem(0, 0o666).is_some());
    }

    #[test]
    fn status_reports_what_the_ui_needs() {
        assert!(!status(&PolicyState::Absent).managed);
        let s = status(&active(Some(vec![&format!("sha256:{A}")])));
        assert!(s.managed && s.pinned_count == Some(1) && s.error.is_none());
        let s = status(&PolicyState::Invalid("why".into()));
        assert!(s.managed && s.error.as_deref() == Some("why"));
    }
}
