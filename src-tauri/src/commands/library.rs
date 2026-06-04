// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use sqlx::Row;
use tauri::command;

use crate::commands::ingest::load_tool_record;
use crate::db::DbState;
use crate::models::{ToolManifest, ToolRecord, ToolWithVersion, VersionRecord};

fn parse_version_row(row: &sqlx::sqlite::SqliteRow) -> Result<VersionRecord, String> {
    let manifest_json: String = row.try_get("manifest").map_err(|e| e.to_string())?;
    let manifest: ToolManifest =
        serde_json::from_str(&manifest_json).map_err(|e| e.to_string())?;
    Ok(VersionRecord {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        tool_id: row.try_get("tool_id").map_err(|e| e.to_string())?,
        version_num: row.try_get("version_num").unwrap_or(1),
        file_size: row.try_get("file_size").unwrap_or(0),
        checksum: row.try_get("checksum").map_err(|e| e.to_string())?,
        manifest,
        quarantined: row.try_get::<i32, _>("quarantined").unwrap_or(0) != 0,
        created_at: row.try_get("created_at").unwrap_or(0),
    })
}

#[command]
pub async fn list_tools(db: tauri::State<'_, DbState>) -> Result<Vec<ToolWithVersion>, String> {
    let tools = sqlx::query("SELECT * FROM tools ORDER BY updated_at DESC")
        .fetch_all(&db.0)
        .await
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in tools {
        let tags_json: String = row.try_get("tags").unwrap_or_else(|_| "[]".into());
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
        let approvals_json: String = row.try_get("approvals").unwrap_or_else(|_| "[]".into());
        let approvals: Vec<crate::models::DetectedCapability> =
            serde_json::from_str(&approvals_json).unwrap_or_default();
        let tool = ToolRecord {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            name: row.try_get("name").map_err(|e| e.to_string())?,
            description: row.try_get("description").unwrap_or_default(),
            tags,
            icon_data: row.try_get("icon_data").unwrap_or(None),
            current_ver: row.try_get("current_ver").unwrap_or(None),
            approvals,
            created_at: row.try_get("created_at").unwrap_or(0),
            updated_at: row.try_get("updated_at").unwrap_or(0),
        };

        let versions = sqlx::query(
            "SELECT * FROM tool_versions WHERE tool_id = $1 ORDER BY version_num DESC",
        )
        .bind(&tool.id)
        .fetch_all(&db.0)
        .await
        .map_err(|e| e.to_string())?;

        let version_records: Vec<VersionRecord> = versions
            .iter()
            .filter_map(|r| parse_version_row(r).ok())
            .collect();

        let current_version = tool
            .current_ver
            .as_ref()
            .and_then(|cv| version_records.iter().find(|v| &v.id == cv).cloned());

        result.push(ToolWithVersion {
            tool,
            current_version,
            all_versions: version_records,
        });
    }
    Ok(result)
}

#[command]
pub async fn get_tool(
    db: tauri::State<'_, DbState>,
    tool_id: String,
) -> Result<ToolWithVersion, String> {
    let tool = load_tool_record(&db.0, &tool_id).await?;

    let versions = sqlx::query(
        "SELECT * FROM tool_versions WHERE tool_id = $1 ORDER BY version_num DESC",
    )
    .bind(&tool_id)
    .fetch_all(&db.0)
    .await
    .map_err(|e| e.to_string())?;

    let version_records: Vec<VersionRecord> = versions
        .iter()
        .filter_map(|r| parse_version_row(r).ok())
        .collect();

    let current_version = tool
        .current_ver
        .as_ref()
        .and_then(|cv| version_records.iter().find(|v| &v.id == cv).cloned());

    Ok(ToolWithVersion {
        tool,
        current_version,
        all_versions: version_records,
    })
}

#[derive(serde::Deserialize)]
pub struct MetadataUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[command]
pub async fn update_metadata(
    db: tauri::State<'_, DbState>,
    tool_id: String,
    update: MetadataUpdate,
) -> Result<ToolRecord, String> {
    let now = chrono::Utc::now().timestamp_millis();

    if let Some(ref name) = update.name {
        sqlx::query("UPDATE tools SET name = $1, updated_at = $2 WHERE id = $3")
            .bind(name)
            .bind(now)
            .bind(&tool_id)
            .execute(&db.0)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref description) = update.description {
        sqlx::query("UPDATE tools SET description = $1, updated_at = $2 WHERE id = $3")
            .bind(description)
            .bind(now)
            .bind(&tool_id)
            .execute(&db.0)
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Some(ref tags) = update.tags {
        let tags_json = serde_json::to_string(tags).map_err(|e| e.to_string())?;
        sqlx::query("UPDATE tools SET tags = $1, updated_at = $2 WHERE id = $3")
            .bind(&tags_json)
            .bind(now)
            .bind(&tool_id)
            .execute(&db.0)
            .await
            .map_err(|e| e.to_string())?;
    }

    load_tool_record(&db.0, &tool_id).await
}

#[command]
pub async fn delete_tool(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, crate::AppDataDir>,
    paths: tauri::State<'_, crate::ActiveToolPaths>,
    tool_id: String,
) -> Result<(), String> {
    // Remove from active protocol handler state
    {
        let mut map = paths.0.lock().unwrap();
        map.remove(&tool_id);
    }

    // Remove content-addressed files. Best-effort — don't fail if already gone.
    let tool_dir = data_dir.0.join("tools").join(&tool_id);
    if tool_dir.exists() {
        std::fs::remove_dir_all(&tool_dir).map_err(|e| e.to_string())?;
    }

    // DB delete — FK cascade removes tool_versions rows.
    sqlx::query("DELETE FROM tools WHERE id = $1")
        .bind(&tool_id)
        .execute(&db.0)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
