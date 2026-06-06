// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use sqlx::{sqlite::SqliteConnectOptions, sqlite::SqlitePoolOptions, SqlitePool};
use std::path::Path;
use std::str::FromStr;

pub struct DbState(pub SqlitePool);

pub async fn create_pool(data_dir: &Path) -> Result<SqlitePool, sqlx::Error> {
    let db_path = data_dir.join("sanctum.db");
    let opts = SqliteConnectOptions::from_str(&format!(
        "sqlite:{}",
        db_path.to_str().expect("db path is valid utf-8")
    ))?
    .create_if_missing(true)
    .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
    .foreign_keys(true);

    SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    // v0 schema
    let schema = include_str!("../migrations/001_schema.sql");
    for stmt in schema.split(';') {
        let s = stmt.trim();
        if !s.is_empty() {
            sqlx::query(s).execute(pool).await?;
        }
    }

    // v1 migrations — idempotent; SQLite returns error on duplicate column, ignore it.
    let v1: &[&str] = &[
        // Per-tool user-approved capabilities (JSON array of DetectedCapability).
        // Drives the dynamic CSP at run time instead of the v0 deny-all constant.
        "ALTER TABLE tools ADD COLUMN approvals TEXT NOT NULL DEFAULT '[]'",
    ];
    for stmt in v1 {
        let _ = sqlx::query(stmt).execute(pool).await; // "duplicate column" → ignore
    }

    Ok(())
}
