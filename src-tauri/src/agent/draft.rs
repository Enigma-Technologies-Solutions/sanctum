// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! What the agent wrote, as the library sees it: a report for the person to read before
//! deciding, and the step that adds it.
//!
//! A draft is an ordinary single-file tool with one difference: it carries the origin `agent`,
//! shown as a badge. It goes through the same ingest as a pasted file (same scan, same
//! versioning, same content-addressed storage) and starts with **no approvals**. Adding it
//! grants nothing; running it still needs the person to approve each capability, exactly like
//! any other tool. The report's capability list comes from the scan, which is advisory: it can
//! miss things, and it is the sandbox, not the scan, that limits a tool.

use crate::commands::ingest::{ingest_html_inner, load_tool_record};
use crate::commands::scan::{extract_description, extract_name, scan_html};
use crate::commands::versioning::{create_version_inner, hash_bytes_hex};
use crate::models::{DetectedCapability, ToolRecord};
use serde::Serialize;
use sqlx::{Row, SqlitePool};
use std::path::Path;

/// The origin stored on a tool the agent wrote.
pub const ORIGIN_AGENT: &str = "agent";

/// What the person is shown before choosing to add a draft.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftReport {
    pub name: String,
    pub description: String,
    pub size: u64,
    /// What the scan found the page asking for. Nothing is granted by it.
    pub capabilities: Vec<DetectedCapability>,
    /// `new` adds a tool; `version` adds a version to the tool this session already added.
    pub saves_as: SavesAs,
    /// The name of the tool a `version` would be added to.
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SavesAs {
    New,
    Version,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AddOutcome {
    /// A new tool is in the library.
    Added,
    /// A new version of the tool this session added earlier.
    NewVersion,
    /// This exact file was already the current version.
    Unchanged,
    /// This exact file was already in the library, as a tool that is not this session's.
    AlreadyInLibrary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub outcome: AddOutcome,
    pub tool: ToolRecord,
    pub version_num: i32,
}

/// The page as text. A draft that is not valid UTF-8 is not a web page.
pub fn text_of(bytes: Vec<u8>) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| "app.html is not text, so it cannot be added.".to_owned())
}

/// The tool this session already added, if it is still in the library.
async fn existing_tool(pool: &SqlitePool, tool_id: Option<&str>) -> Option<ToolRecord> {
    load_tool_record(pool, tool_id?).await.ok()
}

pub async fn report(
    pool: &SqlitePool,
    html: &str,
    session_tool: Option<&str>,
) -> Result<DraftReport, String> {
    let existing = existing_tool(pool, session_tool).await;
    Ok(DraftReport {
        name: extract_name(html),
        description: extract_description(html),
        size: html.len() as u64,
        capabilities: scan_html(html),
        saves_as: if existing.is_some() {
            SavesAs::Version
        } else {
            SavesAs::New
        },
        tool_name: existing.map(|t| t.name),
    })
}

/// Adds the draft to the library, or as a new version of the tool this session added before.
/// Returns what happened.
pub async fn add(
    pool: &SqlitePool,
    data_dir: &Path,
    html: &str,
    session_tool: Option<&str>,
) -> Result<Added, String> {
    let sha = hash_bytes_hex(html.as_bytes());

    // Who already holds this exact file, if anyone.
    let holder: Option<String> = sqlx::query("SELECT tool_id FROM tool_versions WHERE id = $1")
        .bind(&sha)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|r| r.try_get("tool_id").ok());

    if let Some(mine) = existing_tool(pool, session_tool).await {
        if mine.current_ver.as_deref() == Some(sha.as_str()) {
            return Ok(Added {
                outcome: AddOutcome::Unchanged,
                version_num: version_num(pool, &sha).await,
                tool: mine,
            });
        }
        // The same file already belongs to a different tool: do not move it.
        if let Some(other) = holder.as_deref().filter(|h| *h != mine.id) {
            let tool = load_tool_record(pool, other).await?;
            return Ok(Added {
                outcome: AddOutcome::AlreadyInLibrary,
                version_num: version_num(pool, &sha).await,
                tool,
            });
        }
        let v = create_version_inner(pool, data_dir, &mine.id, html).await?;
        let tool = load_tool_record(pool, &mine.id).await?;
        return Ok(Added {
            outcome: AddOutcome::NewVersion,
            version_num: v.version_num,
            tool,
        });
    }

    let r = ingest_html_inner(pool, data_dir, html, Some("app.html")).await?;
    if !r.is_new_tool {
        // Someone already had this exact file. It is theirs, not marked as the agent's.
        return Ok(Added {
            outcome: AddOutcome::AlreadyInLibrary,
            version_num: r.version.version_num,
            tool: r.tool,
        });
    }
    sqlx::query("UPDATE tools SET origin = $1 WHERE id = $2")
        .bind(ORIGIN_AGENT)
        .bind(&r.tool.id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Added {
        outcome: AddOutcome::Added,
        version_num: r.version.version_num,
        tool: load_tool_record(pool, &r.tool.id).await?,
    })
}

/// An app from the library, read to be changed in a conversation.
#[derive(Debug, Clone)]
pub struct Source {
    pub tool_id: String,
    pub name: String,
    pub version_num: i32,
    pub bytes: Vec<u8>,
}

/// Reads the current version of a library tool. The stored file is checked against its hash
/// first, so a file changed on disk is never handed to the agent as if it were the tool.
pub async fn load_source(
    pool: &SqlitePool,
    data_dir: &Path,
    tool_id: &str,
) -> Result<Source, String> {
    let tool = load_tool_record(pool, tool_id)
        .await
        .map_err(|_| "That app is not in your library any more.".to_owned())?;
    let sha = tool
        .current_ver
        .clone()
        .ok_or_else(|| "That app has no version to change.".to_owned())?;
    let row = sqlx::query("SELECT version_num, quarantined FROM tool_versions WHERE id = $1")
        .bind(&sha)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That app has no version to change.".to_owned())?;
    if row.try_get::<i32, _>("quarantined").unwrap_or(0) != 0 {
        return Err("That app failed its integrity check, so it cannot be changed.".into());
    }
    let path = data_dir
        .join("tools")
        .join(tool_id)
        .join("versions")
        .join(&sha)
        .join("index.html");
    let len = std::fs::metadata(&path)
        .map_err(|e| format!("Cannot read the app: {e}"))?
        .len();
    if len > super::chat::MAX_DRAFT_BYTES {
        return Err("That app is larger than Sanctum can send to Codex.".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("Cannot read the app: {e}"))?;
    if hash_bytes_hex(&bytes) != sha {
        return Err("That app failed its integrity check, so it cannot be changed.".into());
    }
    text_of(bytes.clone())
        .map_err(|_| "That app is not text, so Codex cannot change it.".to_owned())?;
    Ok(Source {
        tool_id: tool.id,
        name: tool.name,
        version_num: row.try_get("version_num").unwrap_or(1),
        bytes,
    })
}

async fn version_num(pool: &SqlitePool, sha: &str) -> i32 {
    sqlx::query("SELECT version_num FROM tool_versions WHERE id = $1")
        .bind(sha)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|r| r.try_get("version_num").ok())
        .unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Env {
        pool: SqlitePool,
        dir: std::path::PathBuf,
    }

    impl Env {
        async fn new() -> Env {
            let dir =
                std::env::temp_dir().join(format!("sanctum-draft-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let pool = crate::db::create_pool(&dir).await.unwrap();
            crate::db::run_migrations(&pool).await.unwrap();
            Env { pool, dir }
        }
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    const V1: &str = "<html><head><title>Watermark</title><meta name=\"description\" content=\"Stamps PDFs\"></head><body><p>v1</p></body></html>";
    const V2: &str = "<html><head><title>Watermark</title><meta name=\"description\" content=\"Stamps PDFs\"></head><body><p>v2</p></body></html>";
    const NET: &str = "<html><head><title>Fetcher</title></head><body><script>fetch('https://api.example.com/x')</script></body></html>";

    #[test]
    fn text_must_be_utf8() {
        assert_eq!(text_of(b"<p>hi</p>".to_vec()).unwrap(), "<p>hi</p>");
        assert!(text_of(vec![0xff, 0xfe, 0x00]).is_err());
    }

    #[tokio::test]
    async fn the_report_names_the_tool_and_lists_what_the_scan_found() {
        let env = Env::new().await;
        let r = report(&env.pool, V1, None).await.unwrap();
        assert_eq!(r.name, "Watermark");
        assert_eq!(r.description, "Stamps PDFs");
        assert_eq!(r.size, V1.len() as u64);
        assert!(r.capabilities.is_empty());
        assert_eq!((r.saves_as, r.tool_name), (SavesAs::New, None));

        let r = report(&env.pool, NET, None).await.unwrap();
        assert_eq!(
            r.capabilities,
            vec![DetectedCapability::Net(crate::models::NetCapability {
                net: vec!["api.example.com".into()]
            })]
        );
    }

    #[tokio::test]
    async fn adding_makes_a_tool_marked_as_the_agents_with_no_approvals() {
        let env = Env::new().await;
        let a = add(&env.pool, &env.dir, NET, None).await.unwrap();
        assert_eq!(a.outcome, AddOutcome::Added);
        assert_eq!(a.tool.origin.as_deref(), Some("agent"));
        assert_eq!(a.tool.name, "Fetcher");
        assert_eq!(a.version_num, 1);
        // Detected, but not approved: running it will ask.
        assert!(a.tool.approvals.is_empty());
        let reloaded = load_tool_record(&env.pool, &a.tool.id).await.unwrap();
        assert_eq!(reloaded.origin.as_deref(), Some("agent"));
        assert!(reloaded.approvals.is_empty());
    }

    #[tokio::test]
    async fn a_later_draft_becomes_a_new_version_of_the_same_tool() {
        let env = Env::new().await;
        let first = add(&env.pool, &env.dir, V1, None).await.unwrap();
        let id = first.tool.id.clone();
        let r = report(&env.pool, V2, Some(&id)).await.unwrap();
        assert_eq!(
            (r.saves_as, r.tool_name.as_deref()),
            (SavesAs::Version, Some("Watermark"))
        );
        let second = add(&env.pool, &env.dir, V2, Some(&id)).await.unwrap();
        assert_eq!(second.outcome, AddOutcome::NewVersion);
        assert_eq!(
            second.tool.id, id,
            "same tool, so the same origin and storage"
        );
        assert_eq!(second.version_num, 2);
        assert_eq!(second.tool.origin.as_deref(), Some("agent"));
        let tools: i64 = sqlx::query("SELECT COUNT(*) AS n FROM tools")
            .fetch_one(&env.pool)
            .await
            .unwrap()
            .get("n");
        assert_eq!(tools, 1);
    }

    #[tokio::test]
    async fn adding_the_same_file_twice_changes_nothing() {
        let env = Env::new().await;
        let first = add(&env.pool, &env.dir, V1, None).await.unwrap();
        let again = add(&env.pool, &env.dir, V1, Some(&first.tool.id))
            .await
            .unwrap();
        assert_eq!(again.outcome, AddOutcome::Unchanged);
        assert_eq!(again.version_num, 1);
        // Without the session's tool id it is found by its content instead.
        let found = add(&env.pool, &env.dir, V1, None).await.unwrap();
        assert_eq!(found.outcome, AddOutcome::AlreadyInLibrary);
        assert_eq!(found.tool.id, first.tool.id);
    }

    #[tokio::test]
    async fn a_file_the_person_already_had_is_not_relabelled_as_the_agents() {
        let env = Env::new().await;
        let theirs = ingest_html_inner(&env.pool, &env.dir, V1, Some("mine.html"))
            .await
            .unwrap();
        assert!(theirs.tool.origin.is_none());
        let a = add(&env.pool, &env.dir, V1, None).await.unwrap();
        assert_eq!(a.outcome, AddOutcome::AlreadyInLibrary);
        assert_eq!(a.tool.id, theirs.tool.id);
        assert!(a.tool.origin.is_none(), "it stays theirs");
    }

    #[tokio::test]
    async fn a_new_version_never_takes_over_a_file_that_belongs_to_another_tool() {
        let env = Env::new().await;
        let mine = add(&env.pool, &env.dir, V1, None).await.unwrap();
        let other = ingest_html_inner(&env.pool, &env.dir, V2, Some("other.html"))
            .await
            .unwrap();
        // The agent now writes exactly what another tool holds.
        let a = add(&env.pool, &env.dir, V2, Some(&mine.tool.id))
            .await
            .unwrap();
        assert_eq!(a.outcome, AddOutcome::AlreadyInLibrary);
        assert_eq!(a.tool.id, other.tool.id);
        let still = load_tool_record(&env.pool, &mine.tool.id).await.unwrap();
        assert_eq!(
            still.current_ver.as_deref(),
            Some(hash_bytes_hex(V1.as_bytes()).as_str())
        );
    }

    #[tokio::test]
    async fn a_tool_that_was_deleted_is_added_again_as_new() {
        let env = Env::new().await;
        let first = add(&env.pool, &env.dir, V1, None).await.unwrap();
        sqlx::query("DELETE FROM tools WHERE id = $1")
            .bind(&first.tool.id)
            .execute(&env.pool)
            .await
            .unwrap();
        let r = report(&env.pool, V2, Some(&first.tool.id)).await.unwrap();
        assert_eq!(r.saves_as, SavesAs::New, "the old tool is gone");
        let a = add(&env.pool, &env.dir, V2, Some(&first.tool.id))
            .await
            .unwrap();
        assert_eq!(a.outcome, AddOutcome::Added);
        assert_ne!(a.tool.id, first.tool.id);
    }

    #[tokio::test]
    async fn an_empty_page_is_refused_by_the_normal_ingest() {
        let env = Env::new().await;
        assert!(add(&env.pool, &env.dir, "   ", None).await.is_err());
        assert!(add(&env.pool, &env.dir, "no markup", None).await.is_err());
    }

    #[tokio::test]
    async fn an_app_is_read_for_changing_only_if_its_file_is_intact() {
        let env = Env::new().await;
        let a = add(&env.pool, &env.dir, V1, None).await.unwrap();
        let src = load_source(&env.pool, &env.dir, &a.tool.id).await.unwrap();
        assert_eq!(
            (src.name.as_str(), src.version_num, src.bytes.as_slice()),
            ("Watermark", 1, V1.as_bytes())
        );
        // The current version is the one read.
        add(&env.pool, &env.dir, V2, Some(&a.tool.id))
            .await
            .unwrap();
        let src = load_source(&env.pool, &env.dir, &a.tool.id).await.unwrap();
        assert_eq!((src.version_num, src.bytes.as_slice()), (2, V2.as_bytes()));

        assert!(load_source(&env.pool, &env.dir, "nope").await.is_err());

        // A file changed on disk is not handed over.
        let sha = hash_bytes_hex(V2.as_bytes());
        let path = env
            .dir
            .join("tools")
            .join(&a.tool.id)
            .join("versions")
            .join(&sha)
            .join("index.html");
        std::fs::write(&path, "<p>tampered</p>").unwrap();
        let e = load_source(&env.pool, &env.dir, &a.tool.id)
            .await
            .unwrap_err();
        assert!(e.contains("integrity"), "{e}");

        // Nor is a quarantined one.
        std::fs::write(&path, V2).unwrap();
        sqlx::query("UPDATE tool_versions SET quarantined = 1 WHERE id = $1")
            .bind(&sha)
            .execute(&env.pool)
            .await
            .unwrap();
        assert!(load_source(&env.pool, &env.dir, &a.tool.id).await.is_err());
    }
}
