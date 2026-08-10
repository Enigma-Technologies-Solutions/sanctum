// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

//! Signed update channel.
//!
//! The update check runs in Rust and is exposed to the host UI as two ordinary
//! Sanctum commands. The updater plugin's own IPC commands are deliberately
//! *not* granted to any window — no `updater:*` permission appears in any
//! capability file — so the update machinery is unreachable from a webview even
//! if a tool window were to recover an IPC bootstrap.
//!
//! Trust model: the plugin verifies the minisign signature of both the update
//! manifest and the downloaded payload against the public key baked into
//! `tauri.conf.json` at compile time. A tampered or unsigned artifact is
//! rejected before it touches disk. Transport is HTTPS, but the signature — not
//! TLS — is what makes the channel trustworthy: compromising the release host
//! is not sufficient to ship a malicious update.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// A pending update, as shown to the user before they consent to installing it.
#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
}

/// Ask the release endpoint whether a newer signed build exists.
///
/// Returns `None` when the app is already current. Network failure is an error,
/// not a silent `None` — a security product should not quietly stop checking
/// for patches.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|e| format!("updater unavailable: {e}"))?
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    }))
}

/// Download, verify, and install the pending update, then relaunch.
///
/// The check is deliberately repeated here rather than caching the `Update`
/// handle from `check_for_update`: it keeps the command stateless, and the
/// signature verification that gates the install runs on the artifact actually
/// downloaded in this call.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| format!("updater unavailable: {e}"))?
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?;

    let Some(update) = update else {
        return Err("no update available".into());
    };

    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("update install failed: {e}"))?;

    // Diverges — the process is replaced by the freshly installed build.
    app.restart();
}
