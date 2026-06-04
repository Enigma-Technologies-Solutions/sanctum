// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use tauri::command;

use crate::db::DbState;
use crate::models::{DetectedCapability, ToolRecord};
use crate::commands::ingest::load_tool_record;

/// Persist user-approved capabilities for a tool.
///
/// `approved` is the caller-supplied list of DetectedCapability objects the user
/// has explicitly enabled. Pass `[]` to deny everything (v0 default).
///
/// This replaces the previous approvals list entirely — the caller is responsible
/// for passing the full desired set, not a delta.
///
/// Takes effect on the next `open_tool_window` call; currently-open windows are
/// not affected (would need a window reload to pick up new CSP).
#[command]
pub async fn update_approvals(
    db: tauri::State<'_, DbState>,
    tool_id: String,
    approved: Vec<DetectedCapability>,
) -> Result<ToolRecord, String> {
    let json = serde_json::to_string(&approved).map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();

    sqlx::query("UPDATE tools SET approvals = $1, updated_at = $2 WHERE id = $3")
        .bind(&json)
        .bind(now)
        .bind(&tool_id)
        .execute(&db.0)
        .await
        .map_err(|e| e.to_string())?;

    load_tool_record(&db.0, &tool_id).await
}
