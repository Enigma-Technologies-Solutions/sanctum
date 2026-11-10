// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! What the cached registries say about the tools already in the library: a newer version is
//! listed, or the installed version was withdrawn.
//!
//! Nothing here reaches the network. `check_all` refreshes each registry, which is the only
//! request, and it runs when the user clicks "Check now" or has turned on the optional timer.
//! Everything else reads the cache, verified again on every use.
//!
//! Withdrawn tools follow one rule:
//!
//! - A registry whose signer chains to a key built into Sanctum (`anchored`) can **block** a
//!   tool: the window will not open until the user removes it or installs a good version.
//! - A registry the user pinned (`pinned`) can only **warn**. It is a third party, so it must
//!   not be able to switch off a tool the user got somewhere else.
//!
//! Blocking removes a way to run a tool. It never grants or removes an approval, and a
//! registry that fails verification here is skipped instead of stopping every tool.

use super::client::{ClientError, RefreshReport, RegistryClient};
use super::install::InstallState;
use serde::Serialize;
use sqlx::Row;

/// What Sanctum does about a withdrawn tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RevokedAction {
    /// The tool will not open.
    Block,
    /// The tool still opens, and the library says it was withdrawn.
    Warn,
}

/// Only a registry anchored in the app may block. A pinned one is a third party.
pub(super) fn action_for(registry_trust: &str) -> RevokedAction {
    if registry_trust == "anchored" {
        RevokedAction::Block
    } else {
        RevokedAction::Warn
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNotice {
    pub registry_id: String,
    pub registry_name: String,
    pub app_id: String,
    pub name: String,
    pub installed_version: String,
    pub latest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedNotice {
    pub tool_id: String,
    pub name: String,
    pub app_id: String,
    pub version: String,
    pub reason: String,
    pub registry_id: String,
    pub registry_name: String,
    pub action: RevokedAction,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notices {
    pub updates: Vec<UpdateNotice>,
    pub revoked: Vec<RevokedNotice>,
}

/// The result of checking one registry.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CheckOutcome {
    #[serde(rename_all = "camelCase")]
    Checked { report: Box<RefreshReport> },
    /// The registry could not be refreshed. The cached copy is untouched and still used.
    #[serde(rename_all = "camelCase")]
    Failed { code: String, message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckItem {
    pub registry_id: String,
    pub registry_name: String,
    #[serde(flatten)]
    pub outcome: CheckOutcome,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub items: Vec<CheckItem>,
    pub notices: Notices,
}

impl RegistryClient {
    /// Refresh every registry, one after another, then say what changed for the library.
    /// A registry that fails is reported and does not stop the others.
    pub async fn check_all(&self) -> Result<CheckReport, ClientError> {
        let mut items = Vec::new();
        for r in self.list().await? {
            let outcome = match self.refresh(&r.id).await {
                Ok(report) => CheckOutcome::Checked {
                    report: Box::new(report),
                },
                Err(e) => CheckOutcome::Failed {
                    code: e.code().to_string(),
                    message: e.to_string(),
                },
            };
            items.push(CheckItem {
                registry_id: r.id,
                registry_name: r.name,
                outcome,
            });
        }
        Ok(CheckReport {
            items,
            notices: self.notices().await?,
        })
    }

    /// Updates and withdrawals for what is installed, from the cache. No network.
    pub async fn notices(&self) -> Result<Notices, ClientError> {
        let mut out = Notices::default();
        for r in self.list().await? {
            // A registry whose cache no longer verifies is skipped, not fatal.
            let Ok(cat) = self.catalogue(&r.id).await else {
                continue;
            };
            for app in &cat.apps {
                if app.state == InstallState::UpdateAvailable && !app.latest_revoked {
                    out.updates.push(UpdateNotice {
                        registry_id: r.id.clone(),
                        registry_name: r.name.clone(),
                        app_id: app.app_id.clone(),
                        name: app.name.clone(),
                        installed_version: app.installed_version.clone().unwrap_or_default(),
                        latest: app.latest.clone(),
                    });
                }
            }
            let Ok(cached) = self.cached(&r.id).await else {
                continue;
            };
            let Some(rev) = cached.revocations.as_ref() else {
                continue;
            };
            for tool in self.running_versions().await? {
                let Some(entry) = rev
                    .revocations
                    .entries
                    .iter()
                    .find(|e| e.checksum == format!("sha256:{}", tool.version_id))
                else {
                    continue;
                };
                out.revoked.push(RevokedNotice {
                    tool_id: tool.tool_id,
                    name: tool.name,
                    app_id: tool.app_id,
                    version: tool.version,
                    reason: entry.reason.clone(),
                    registry_id: r.id.clone(),
                    registry_name: r.name.clone(),
                    action: action_for(&r.trust),
                });
            }
        }
        // One line for each tool: a block from any registry outweighs a warning from another.
        out.revoked.sort_by(|a, b| {
            (a.tool_id.as_str(), a.action == RevokedAction::Warn)
                .cmp(&(b.tool_id.as_str(), b.action == RevokedAction::Warn))
        });
        out.revoked.dedup_by(|b, a| a.tool_id == b.tool_id);
        Ok(out)
    }

    /// Why this exact version must not open, if an anchored registry withdrew it.
    /// `sha` is the library's version id: the hex of the checksum.
    pub async fn blocked_reason(&self, sha: &str) -> Option<String> {
        let notices = self.notices_for(sha).await.ok()?;
        notices
            .into_iter()
            .find(|n| n.action == RevokedAction::Block)
            .map(|n| format!("{} withdrew this version ({}).", n.registry_name, n.reason))
    }

    /// Withdrawals that name this version, one for each registry.
    pub async fn notices_for(&self, sha: &str) -> Result<Vec<RevokedNotice>, ClientError> {
        let checksum = format!("sha256:{sha}");
        let mut out = Vec::new();
        for r in self.list().await? {
            let Ok(cached) = self.cached(&r.id).await else {
                continue;
            };
            let Some(rev) = cached.revocations.as_ref() else {
                continue;
            };
            if let Some(e) = rev
                .revocations
                .entries
                .iter()
                .find(|e| e.checksum == checksum)
            {
                out.push(RevokedNotice {
                    tool_id: String::new(),
                    name: String::new(),
                    app_id: e.app_id.clone(),
                    version: String::new(),
                    reason: e.reason.clone(),
                    registry_id: r.id.clone(),
                    registry_name: r.name.clone(),
                    action: action_for(&r.trust),
                });
            }
        }
        Ok(out)
    }

    /// The version each registry-installed tool runs now.
    async fn running_versions(&self) -> Result<Vec<Running>, ClientError> {
        let rows = sqlx::query(
            "SELECT t.id AS tool_id, t.name AS name, t.current_ver AS version_id, \
             p.app_id AS app_id, p.version AS version \
             FROM tools t JOIN bundle_provenance p ON p.version_id = t.current_ver",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ClientError::BundleRefused(e.to_string()))?;
        Ok(rows
            .iter()
            .map(|r| Running {
                tool_id: r.get("tool_id"),
                name: r.get("name"),
                version_id: r.get("version_id"),
                app_id: r.get("app_id"),
                version: r.get("version"),
            })
            .collect())
    }
}

struct Running {
    tool_id: String,
    name: String,
    version_id: String,
    app_id: String,
    version: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_anchored_registry_may_block() {
        assert_eq!(action_for("anchored"), RevokedAction::Block);
        assert_eq!(action_for("pinned"), RevokedAction::Warn);
        assert_eq!(action_for("anything else"), RevokedAction::Warn);
    }
}
