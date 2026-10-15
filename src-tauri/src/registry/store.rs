// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! The `registries` table. Every write here follows a verification in `client.rs`; nothing in
//! this module decides what is trustworthy. Updates that change cached bytes happen in one
//! transaction, so a registry is never left with a new index and an old signature.

use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRevocations {
    pub json: Vec<u8>,
    pub sig: Vec<u8>,
    pub serial: i64,
    pub sha256: String,
    pub expires: i64,
    pub fetched_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRegistry {
    pub id: String,
    pub base_url: String,
    pub name: String,
    pub kind: String,
    /// `anchored` (signer chains to a compiled-in key) or `pinned` (the user pinned the key).
    pub trust: String,
    pub pinned_key: Option<String>,
    /// Display name of whoever the signature identifies.
    pub publisher: String,
    pub signer: String,
    pub app_count: i64,
    pub added_at: i64,
    pub last_checked_at: Option<i64>,
    pub last_error: Option<String>,
    pub index_json: Vec<u8>,
    pub index_sig: Vec<u8>,
    pub index_serial: i64,
    pub index_sha256: String,
    pub index_issued_at: i64,
    pub index_expires: i64,
    pub index_fetched_at: i64,
    pub revocations: Option<StoredRevocations>,
}

#[derive(Debug)]
pub enum StoreError {
    /// A registry with this id or address already exists.
    Duplicate,
    Db(String),
}

impl From<sqlx::Error> for StoreError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::Database(d) if d.is_unique_violation() => StoreError::Duplicate,
            _ => StoreError::Db(e.to_string()),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::Duplicate => write!(f, "this registry is already added"),
            StoreError::Db(m) => write!(f, "database error: {m}"),
        }
    }
}

const COLUMNS: &str = "id, base_url, name, kind, trust, pinned_key, publisher, signer, app_count, \
    added_at, last_checked_at, last_error, index_json, index_sig, index_serial, index_sha256, \
    index_issued_at, index_expires, index_fetched_at, rev_json, rev_sig, rev_serial, rev_sha256, \
    rev_expires, rev_fetched_at";

fn from_row(r: &sqlx::sqlite::SqliteRow) -> StoredRegistry {
    let rev_json: Option<Vec<u8>> = r.get("rev_json");
    let revocations = rev_json.map(|json| StoredRevocations {
        json,
        sig: r.get::<Option<Vec<u8>>, _>("rev_sig").unwrap_or_default(),
        serial: r.get::<Option<i64>, _>("rev_serial").unwrap_or(0),
        sha256: r.get::<Option<String>, _>("rev_sha256").unwrap_or_default(),
        expires: r.get::<Option<i64>, _>("rev_expires").unwrap_or(0),
        fetched_at: r.get::<Option<i64>, _>("rev_fetched_at").unwrap_or(0),
    });
    StoredRegistry {
        id: r.get("id"),
        base_url: r.get("base_url"),
        name: r.get("name"),
        kind: r.get("kind"),
        trust: r.get("trust"),
        pinned_key: r.get("pinned_key"),
        publisher: r.get("publisher"),
        signer: r.get("signer"),
        app_count: r.get("app_count"),
        added_at: r.get("added_at"),
        last_checked_at: r.get("last_checked_at"),
        last_error: r.get("last_error"),
        index_json: r.get("index_json"),
        index_sig: r.get("index_sig"),
        index_serial: r.get("index_serial"),
        index_sha256: r.get("index_sha256"),
        index_issued_at: r.get("index_issued_at"),
        index_expires: r.get("index_expires"),
        index_fetched_at: r.get("index_fetched_at"),
        revocations,
    }
}

pub async fn insert(pool: &SqlitePool, r: &StoredRegistry) -> Result<(), StoreError> {
    let rev = r.revocations.as_ref();
    sqlx::query(&format!(
        "INSERT INTO registries ({COLUMNS}) VALUES \
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ))
    .bind(&r.id)
    .bind(&r.base_url)
    .bind(&r.name)
    .bind(&r.kind)
    .bind(&r.trust)
    .bind(&r.pinned_key)
    .bind(&r.publisher)
    .bind(&r.signer)
    .bind(r.app_count)
    .bind(r.added_at)
    .bind(r.last_checked_at)
    .bind(&r.last_error)
    .bind(&r.index_json)
    .bind(&r.index_sig)
    .bind(r.index_serial)
    .bind(&r.index_sha256)
    .bind(r.index_issued_at)
    .bind(r.index_expires)
    .bind(r.index_fetched_at)
    .bind(rev.map(|v| &v.json))
    .bind(rev.map(|v| &v.sig))
    .bind(rev.map(|v| v.serial))
    .bind(rev.map(|v| &v.sha256))
    .bind(rev.map(|v| v.expires))
    .bind(rev.map(|v| v.fetched_at))
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<StoredRegistry>, StoreError> {
    let row = sqlx::query(&format!("SELECT {COLUMNS} FROM registries WHERE id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(from_row))
}

pub async fn find_by_url(
    pool: &SqlitePool,
    base_url: &str,
) -> Result<Option<StoredRegistry>, StoreError> {
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM registries WHERE base_url = ?"
    ))
    .bind(base_url)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(from_row))
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<StoredRegistry>, StoreError> {
    let rows = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM registries ORDER BY added_at, id"
    ))
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(from_row).collect())
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<bool, StoreError> {
    let r = sqlx::query("DELETE FROM registries WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// What a successful refresh changes. `None` fields leave the stored value alone.
pub struct RefreshUpdate<'a> {
    pub checked_at: i64,
    pub last_error: Option<&'a str>,
    pub index: Option<IndexUpdate<'a>>,
    pub revocations: Option<&'a StoredRevocations>,
}

pub struct IndexUpdate<'a> {
    pub name: &'a str,
    pub kind: &'a str,
    pub trust: &'a str,
    pub pinned_key: Option<&'a str>,
    pub publisher: &'a str,
    pub signer: &'a str,
    pub app_count: i64,
    pub json: &'a [u8],
    pub sig: &'a [u8],
    pub serial: i64,
    pub sha256: &'a str,
    pub issued_at: i64,
    pub expires: i64,
    pub fetched_at: i64,
}

/// Apply a refresh in one transaction: the index and its signature change together, the
/// revocations and theirs change together, or nothing changes.
pub async fn save_refresh(
    pool: &SqlitePool,
    id: &str,
    u: &RefreshUpdate<'_>,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE registries SET last_checked_at = ?, last_error = ? WHERE id = ?")
        .bind(u.checked_at)
        .bind(u.last_error)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if let Some(i) = &u.index {
        sqlx::query(
            "UPDATE registries SET name = ?, kind = ?, trust = ?, pinned_key = ?, publisher = ?, \
             signer = ?, app_count = ?, index_json = ?, index_sig = ?, index_serial = ?, \
             index_sha256 = ?, index_issued_at = ?, index_expires = ?, index_fetched_at = ? \
             WHERE id = ?",
        )
        .bind(i.name)
        .bind(i.kind)
        .bind(i.trust)
        .bind(i.pinned_key)
        .bind(i.publisher)
        .bind(i.signer)
        .bind(i.app_count)
        .bind(i.json)
        .bind(i.sig)
        .bind(i.serial)
        .bind(i.sha256)
        .bind(i.issued_at)
        .bind(i.expires)
        .bind(i.fetched_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(r) = u.revocations {
        sqlx::query(
            "UPDATE registries SET rev_json = ?, rev_sig = ?, rev_serial = ?, rev_sha256 = ?, \
             rev_expires = ?, rev_fetched_at = ? WHERE id = ?",
        )
        .bind(&r.json)
        .bind(&r.sig)
        .bind(r.serial)
        .bind(&r.sha256)
        .bind(r.expires)
        .bind(r.fetched_at)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Note a failed refresh. Only the check time and the message change: the cached, verified
/// copy stays exactly as it was.
pub async fn record_failure(
    pool: &SqlitePool,
    id: &str,
    checked_at: i64,
    message: &str,
) -> Result<(), StoreError> {
    sqlx::query("UPDATE registries SET last_checked_at = ?, last_error = ? WHERE id = ?")
        .bind(checked_at)
        .bind(message)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
