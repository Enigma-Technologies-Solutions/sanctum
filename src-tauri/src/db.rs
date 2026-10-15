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
        // Stable identity for tools installed from a signed bundle (see docs/registry.md).
        // Maps a publisher's app_id to one library tool, so updates keep the tool id and
        // therefore the origin and its storage.
        "ALTER TABLE tools ADD COLUMN app_id TEXT",
    ];
    for stmt in v1 {
        let _ = sqlx::query(stmt).execute(pool).await; // "duplicate column" → ignore
    }

    // Bundle provenance. Not idempotent-by-error like the ALTERs above: failures here are real.
    let v2: &[&str] = &[
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tools_app_id ON tools(app_id) WHERE app_id IS NOT NULL",
        "CREATE TABLE IF NOT EXISTS bundle_provenance (
            version_id     TEXT    PRIMARY KEY REFERENCES tool_versions(id) ON DELETE CASCADE,
            app_id         TEXT    NOT NULL,
            publisher_key  TEXT    NOT NULL,
            publisher_name TEXT,
            trust          TEXT    NOT NULL,
            name           TEXT    NOT NULL,
            version        TEXT    NOT NULL,
            statement      TEXT    NOT NULL,
            signature      TEXT    NOT NULL,
            issued_at      INTEGER NOT NULL,
            installed_at   INTEGER NOT NULL
        )",
        "CREATE INDEX IF NOT EXISTS idx_provenance_app ON bundle_provenance(app_id)",
    ];
    for stmt in v2 {
        sqlx::query(stmt).execute(pool).await?;
    }

    // Registries the user added (docs/registry-format.md). A row exists only once a verified
    // index has been fetched, and the verified bytes are cached beside it so the catalogue
    // works offline. The cache is never trusted on its own: it is verified again on use.
    let v3: &[&str] = &["CREATE TABLE IF NOT EXISTS registries (
            id              TEXT    PRIMARY KEY,
            base_url        TEXT    NOT NULL UNIQUE,
            name            TEXT    NOT NULL,
            kind            TEXT    NOT NULL,
            trust           TEXT    NOT NULL CHECK (trust IN ('anchored', 'pinned')),
            pinned_key      TEXT,
            publisher       TEXT    NOT NULL,
            signer          TEXT    NOT NULL,
            app_count       INTEGER NOT NULL,
            added_at        INTEGER NOT NULL,
            last_checked_at INTEGER,
            last_error      TEXT,
            index_json      BLOB    NOT NULL,
            index_sig       BLOB    NOT NULL,
            index_serial    INTEGER NOT NULL,
            index_sha256    TEXT    NOT NULL,
            index_issued_at INTEGER NOT NULL,
            index_expires   INTEGER NOT NULL,
            index_fetched_at INTEGER NOT NULL,
            rev_json        BLOB,
            rev_sig         BLOB,
            rev_serial      INTEGER,
            rev_sha256      TEXT,
            rev_expires     INTEGER,
            rev_fetched_at  INTEGER
        )"];
    for stmt in v3 {
        sqlx::query(stmt).execute(pool).await?;
    }

    Ok(())
}
