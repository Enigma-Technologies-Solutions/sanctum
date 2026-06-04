// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use sha2::{Digest, Sha256};
use sqlx::Row;
use tauri::command;

use crate::db::DbState;
use crate::models::{ToolManifest, VersionRecord};
use crate::AppDataDir;

/// SHA-256 of raw bytes, returned as "sha256:{hex}".
pub fn hash_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("sha256:{}", hex::encode(h.finalize()))
}

/// Hex-only SHA-256 (no prefix) — content-addressed directory name.
pub fn hash_bytes_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

#[command]
pub fn compute_checksum(html: String) -> String {
    hash_bytes(html.as_bytes())
}

/// Add a new version of an existing tool.
/// Also used internally by ingest_html for version creation.
#[command]
pub async fn create_version(
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
    tool_id: String,
    html: String,
) -> Result<VersionRecord, String> {
    create_version_inner(&db.0, &data_dir.0, &tool_id, &html).await
}

/// Core version-creation logic — callable from ingest without needing State.
pub async fn create_version_inner(
    pool: &sqlx::SqlitePool,
    data_dir: &std::path::Path,
    tool_id: &str,
    html: &str,
) -> Result<VersionRecord, String> {
    let bytes = html.as_bytes();
    let sha = hash_bytes_hex(bytes);
    let checksum = format!("sha256:{}", sha);

    // Check if this exact content already exists as a version (deduplicate)
    let existing = sqlx::query("SELECT id, version_num FROM tool_versions WHERE id = $1")
        .bind(&sha)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(row) = existing {
        // Already stored — just update current_ver pointer
        let version_num: i32 = row.try_get("version_num").unwrap_or(1);
        let now = chrono::Utc::now().timestamp_millis();
        sqlx::query("UPDATE tools SET current_ver = $1, updated_at = $2 WHERE id = $3")
            .bind(&sha)
            .bind(now)
            .bind(tool_id)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;

        let manifest_row =
            sqlx::query("SELECT manifest, file_size, quarantined, created_at FROM tool_versions WHERE id = $1")
                .bind(&sha)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        let manifest_json: String = manifest_row.try_get("manifest").unwrap();
        let manifest: ToolManifest =
            serde_json::from_str(&manifest_json).map_err(|e| e.to_string())?;
        return Ok(VersionRecord {
            id: sha.clone(),
            tool_id: tool_id.to_string(),
            version_num,
            file_size: manifest_row.try_get("file_size").unwrap_or(0),
            checksum,
            manifest,
            quarantined: manifest_row.try_get::<i32, _>("quarantined").unwrap_or(0) != 0,
            created_at: manifest_row.try_get("created_at").unwrap_or(0),
        });
    }

    // New version — find next version number
    let row = sqlx::query(
        "SELECT COALESCE(MAX(version_num), 0) as mx FROM tool_versions WHERE tool_id = $1",
    )
    .bind(tool_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    let next_num: i32 = row.try_get::<i32, _>("mx").unwrap_or(0) + 1;
    let now = chrono::Utc::now().timestamp_millis();

    // Write file to content-addressed path
    let version_dir = data_dir
        .join("tools")
        .join(tool_id)
        .join("versions")
        .join(&sha);
    std::fs::create_dir_all(&version_dir).map_err(|e| e.to_string())?;
    std::fs::write(version_dir.join("index.html"), bytes).map_err(|e| e.to_string())?;

    // Derive manifest
    let detected = crate::commands::scan::scan_html(html);
    let name = crate::commands::scan::extract_name(html);
    let manifest = ToolManifest {
        name,
        version: format!("1.0.{}", next_num),
        checksum: checksum.clone(),
        detected,
        signature: None,
    };
    let manifest_json = serde_json::to_string(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(version_dir.join("manifest.json"), manifest_json.as_bytes())
        .map_err(|e| e.to_string())?;

    sqlx::query(
        "INSERT INTO tool_versions
         (id, tool_id, version_num, file_size, checksum, manifest, quarantined, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)",
    )
    .bind(&sha)
    .bind(tool_id)
    .bind(next_num)
    .bind(bytes.len() as i64)
    .bind(&checksum)
    .bind(&manifest_json)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE tools SET current_ver = $1, updated_at = $2 WHERE id = $3")
        .bind(&sha)
        .bind(now)
        .bind(tool_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(VersionRecord {
        id: sha,
        tool_id: tool_id.to_string(),
        version_num: next_num,
        file_size: bytes.len() as i64,
        checksum,
        manifest,
        quarantined: false,
        created_at: now,
    })
}

#[command]
pub async fn rollback_version(
    db: tauri::State<'_, DbState>,
    tool_id: String,
    version_id: String,
) -> Result<(), String> {
    let row = sqlx::query(
        "SELECT id, quarantined FROM tool_versions WHERE id = $1 AND tool_id = $2",
    )
    .bind(&version_id)
    .bind(&tool_id)
    .fetch_optional(&db.0)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        None => return Err("Version not found for this tool".into()),
        Some(r) => {
            let quarantined: i32 = r.try_get("quarantined").unwrap_or(0);
            if quarantined != 0 {
                return Err("Cannot roll back to a quarantined version".into());
            }
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query("UPDATE tools SET current_ver = $1, updated_at = $2 WHERE id = $3")
        .bind(&version_id)
        .bind(now)
        .bind(&tool_id)
        .execute(&db.0)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
