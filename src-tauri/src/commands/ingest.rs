// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use sqlx::Row;
use tauri::command;
use uuid::Uuid;

use crate::commands::scan::{extract_description, extract_icon, extract_name};
use crate::commands::versioning::create_version_inner;
use crate::db::DbState;
use crate::models::{ToolRecord, VersionRecord};
use crate::AppDataDir;

pub struct IngestResult {
    pub tool: ToolRecord,
    pub version: VersionRecord,
    pub is_new_tool: bool,
}

impl serde::Serialize for IngestResult {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("IngestResult", 3)?;
        st.serialize_field("tool", &self.tool)?;
        st.serialize_field("version", &self.version)?;
        st.serialize_field("isNewTool", &self.is_new_tool)?;
        st.end()
    }
}

/// Core ingest logic — create or update a tool from raw HTML.
pub async fn ingest_html_inner(
    pool: &sqlx::SqlitePool,
    data_dir: &std::path::Path,
    html: &str,
    source_filename: Option<&str>,
) -> Result<IngestResult, String> {
    if html.trim().is_empty() {
        return Err("HTML content is empty".into());
    }

    // Check it looks like HTML — permissive: any text with < is accepted
    // (AI tools don't always emit a full doctype)
    if !html.contains('<') {
        return Err("Content does not appear to be HTML".into());
    }

    let name = extract_name(html);
    let description = extract_description(html);
    let icon_data = extract_icon(html);

    // Check if a tool with this exact first-version SHA already exists
    let sha = crate::commands::versioning::hash_bytes_hex(html.as_bytes());
    let existing_version = sqlx::query("SELECT tool_id FROM tool_versions WHERE id = $1")
        .bind(&sha)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    let (tool_id, is_new_tool) = if let Some(row) = existing_version {
        let tid: String = row.try_get("tool_id").map_err(|e| e.to_string())?;
        (tid, false)
    } else {
        // Is there already a tool with this name? If so, add a version.
        // (Heuristic: same name = same tool being updated by the user.)
        // In v0 we always create a new tool unless the sha matches exactly.
        let new_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();

        let display_name = source_filename
            .filter(|f| !f.is_empty() && f != &"clipboard")
            .map(|f| {
                std::path::Path::new(f)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or(&name)
                    .to_string()
            })
            .unwrap_or(name.clone());

        sqlx::query(
            "INSERT INTO tools (id, name, description, tags, icon_data, current_ver, created_at, updated_at)
             VALUES ($1, $2, $3, '[]', $4, NULL, $5, $5)",
        )
        .bind(&new_id)
        .bind(&display_name)
        .bind(&description)
        .bind(&icon_data)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

        (new_id, true)
    };

    let version = create_version_inner(pool, data_dir, &tool_id, html).await?;

    // Reload tool record
    let tool = load_tool_record(pool, &tool_id).await?;

    Ok(IngestResult {
        tool,
        version,
        is_new_tool,
    })
}

pub async fn load_tool_record(
    pool: &sqlx::SqlitePool,
    tool_id: &str,
) -> Result<ToolRecord, String> {
    let row = sqlx::query("SELECT * FROM tools WHERE id = $1")
        .bind(tool_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;

    let tags_json: String = row.try_get("tags").unwrap_or_else(|_| "[]".into());
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

    let approvals_json: String = row.try_get("approvals").unwrap_or_else(|_| "[]".into());
    let approvals: Vec<crate::models::DetectedCapability> =
        serde_json::from_str(&approvals_json).unwrap_or_default();

    Ok(ToolRecord {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        name: row.try_get("name").map_err(|e| e.to_string())?,
        description: row.try_get("description").unwrap_or_default(),
        tags,
        icon_data: row.try_get("icon_data").unwrap_or(None),
        current_ver: row.try_get("current_ver").unwrap_or(None),
        approvals,
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Ingest an HTML file from a filesystem path.
/// Used by drag-and-drop and the "Open file" dialog path (path returned by
/// the dialog plugin, file read on the Rust side — no fs plugin needed in JS).
#[command]
pub async fn ingest_from_path(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
    path: String,
) -> Result<IngestResult, String> {
    let html = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read file '{}': {}", path, e))?;
    let filename = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());
    ingest_html_inner(&db.0, &data_dir.0, &html, filename.as_deref()).await
}

#[command]
pub async fn ingest_html(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
    html: String,
    source_filename: Option<String>,
) -> Result<IngestResult, String> {
    ingest_html_inner(&db.0, &data_dir.0, &html, source_filename.as_deref()).await
}

/// Read text from the OS clipboard and ingest it as an HTML tool.
/// Errors with a clear message if clipboard is empty or doesn't look like HTML.
#[command]
pub async fn ingest_from_clipboard(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
) -> Result<IngestResult, String> {
    let html = read_clipboard()?;
    ingest_html_inner(&db.0, &data_dir.0, &html, Some("clipboard")).await
}

fn read_clipboard() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| format!("Clipboard error: {e}"))?;
    cb.get_text()
        .map_err(|e| format!("Clipboard read error: {e}"))
}

/// Add a new version to an existing tool from the OS clipboard.
/// Errors if the tool_id does not exist.
#[command]
pub async fn update_tool_from_clipboard(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
    tool_id: String,
) -> Result<crate::models::VersionRecord, String> {
    let html = read_clipboard()?;
    verify_tool_exists(&db.0, &tool_id).await?;
    crate::commands::versioning::create_version_inner(&db.0, &data_dir.0, &tool_id, &html).await
}

/// Add a new version to an existing tool from a file path.
#[command]
pub async fn update_tool_from_path(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
    tool_id: String,
    path: String,
) -> Result<crate::models::VersionRecord, String> {
    let html = std::fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read file '{}': {}", path, e))?;
    verify_tool_exists(&db.0, &tool_id).await?;
    crate::commands::versioning::create_version_inner(&db.0, &data_dir.0, &tool_id, &html).await
}

async fn verify_tool_exists(pool: &sqlx::SqlitePool, tool_id: &str) -> Result<(), String> {
    sqlx::query("SELECT id FROM tools WHERE id = $1")
        .bind(tool_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Tool not found: {tool_id}"))?;
    Ok(())
}
