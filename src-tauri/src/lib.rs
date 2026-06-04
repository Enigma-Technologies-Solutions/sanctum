// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub mod commands;
pub mod db;
pub mod device_broker;
pub mod models;
pub mod policy;
pub mod registry;
pub mod signing;

// ── Managed state ─────────────────────────────────────────────────────────────

/// App data directory — stable, injectable into commands without AppHandle.
pub struct AppDataDir(pub PathBuf);

/// Map from tool_id → (version directory, pre-computed CSP string).
/// Populated by open_tool_window with the dynamic CSP built from user approvals.
/// The protocol handler reads both on every request — no DB round-trip needed.
pub struct ActiveToolPaths(pub Mutex<HashMap<String, (PathBuf, String)>>);

// CSP is no longer a global constant — it is computed per-tool in runner.rs
// based on the user's approved capabilities and stored in ActiveToolPaths alongside
// the version directory. The protocol handler reads the stored CSP on each request.

// ── Custom protocol handler ───────────────────────────────────────────────────

fn serve_tool_file(
    app: &tauri::AppHandle,
    webview_label: &str,
    uri: &str,
) -> tauri::http::Response<Vec<u8>> {
    // Derive tool_id from webview label: "tool-{tool_id}"
    let tool_id = match webview_label.strip_prefix("tool-") {
        Some(id) if !id.is_empty() => id,
        _ => return error_response(403, "Forbidden: invalid tool label"),
    };

    // Look up version directory + pre-computed CSP for this tool
    let state = app.state::<ActiveToolPaths>();
    let (version_dir, csp) = {
        let map = state.0.lock().unwrap();
        match map.get(tool_id) {
            Some(entry) => entry.clone(),
            None => return error_response(404, "Tool not loaded"),
        }
    };

    // Parse the request path from the URI (scheme://host/path)
    let path_str = if let Some(after_scheme) = uri.split("://").nth(1) {
        // after_scheme = "tool-{id}/path/to/file"
        let without_host = after_scheme
            .splitn(2, '/')
            .nth(1)
            .unwrap_or("index.html");
        // Strip query/fragment
        without_host
            .split('?')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
    } else {
        "index.html"
    };

    let relative = if path_str.is_empty() || path_str == "/" {
        "index.html"
    } else {
        path_str
    };

    // Build the candidate path and check for traversal
    // v0-todo(hardening): use a pure-Rust path normalizer that doesn't require
    // the file to exist (canonicalize fails on missing files). For now we validate
    // by component stripping and fall back to canonicalize for confirmation.
    let candidate = version_dir.join(relative);

    // Component-level traversal check (no canonicalize needed)
    let mut resolved = version_dir.clone();
    for component in std::path::Path::new(relative).components() {
        use std::path::Component;
        match component {
            Component::Normal(seg) => resolved.push(seg),
            Component::CurDir => {}
            // Any parent-dir or absolute component is a traversal attempt
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return error_response(403, "Path traversal denied");
            }
        }
    }

    // Confirm resolved is still inside version_dir via canonicalize (belt+suspenders)
    // Only do this if the file exists; missing file → 404, not 403.
    if candidate.exists() {
        match (candidate.canonicalize(), version_dir.canonicalize()) {
            (Ok(canon_file), Ok(canon_dir)) => {
                if !canon_file.starts_with(&canon_dir) {
                    return error_response(403, "Path traversal denied (canonical check)");
                }
            }
            _ => {} // let the read attempt below produce the 404
        }
    }

    let content = match std::fs::read(&resolved) {
        Ok(c) => c,
        Err(_) => return error_response(404, "Not found"),
    };

    let mime = mime_guess::from_path(&resolved)
        .first_or_text_plain()
        .to_string();

    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .header("X-Frame-Options", "DENY")
        // Prevent the host UI from framing tool windows
        .header("X-Sanctum-Origin", "tool")
        .body(content)
        .expect("valid response")
}

fn error_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(msg.as_bytes().to_vec())
        .expect("valid error response")
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ActiveToolPaths(Mutex::new(HashMap::new())))
        // Register sanctum-tool:// custom protocol.
        //
        // Storage isolation: each tool is served from a distinct host
        // (sanctum-tool://tool-{id}/) which is a distinct web origin.
        // localStorage, IndexedDB, cookies, service workers, and cache
        // are all scoped to origin by WebKit/WebView2/WebKitGTK, so two
        // tools can never see each other's storage — no extra configuration
        // required. This is verified at the browser-security-model level.
        //
        // We verified isolation by writing key "test" in tool-A's localStorage,
        // then confirming tool-B (different tool_id → different origin) returns
        // undefined for that key. See acceptance criterion 4 in README.
        .register_asynchronous_uri_scheme_protocol("sanctum-tool", |ctx, request, responder| {
            let label = ctx.webview_label().to_string();
            let app = ctx.app_handle().clone();
            let uri = request.uri().to_string();
            std::thread::spawn(move || {
                let response = serve_tool_file(&app, &label, &uri);
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::ingest::ingest_html,
            commands::ingest::ingest_from_clipboard,
            commands::ingest::ingest_from_path,
            commands::library::list_tools,
            commands::library::get_tool,
            commands::library::update_metadata,
            commands::versioning::create_version,
            commands::versioning::compute_checksum,
            commands::versioning::rollback_version,
            commands::scan::scan_capabilities,
            commands::scan::capabilities_for_manifest,
            commands::runner::open_tool_window,
            commands::approvals::update_approvals,
            commands::library::delete_tool,
            commands::ingest::update_tool_from_clipboard,
            commands::ingest::update_tool_from_path,
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("cannot determine app data dir");
            std::fs::create_dir_all(&data_dir)
                .expect("cannot create app data dir");

            // Ensure tools directory exists
            std::fs::create_dir_all(data_dir.join("tools"))
                .expect("cannot create tools dir");

            let pool = tauri::async_runtime::block_on(db::create_pool(&data_dir))
                .expect("cannot open SQLite database");
            tauri::async_runtime::block_on(db::run_migrations(&pool))
                .expect("database migration failed");

            app.manage(db::DbState(pool));
            app.manage(AppDataDir(data_dir));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running Sanctum");
}
