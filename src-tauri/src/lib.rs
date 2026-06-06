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

    // Resolve the request path purely in memory — no canonicalize(), no filesystem
    // access. normalize_within() walks components onto a stack and pops on `..`;
    // if the stack underflows the path would escape version_dir → 403.
    let resolved = match normalize_within(&version_dir, relative) {
        Ok(p) => p,
        Err(_) => return error_response(403, "Path traversal denied"),
    };

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

/// Resolve `relative` against `base` without any filesystem access.
///
/// Algorithm: walk components onto a stack; pop on `..`; error if the stack
/// would underflow (path escapes `base`); error on any absolute component.
/// By construction the returned path always starts with `base`.
///
/// This replaces the previous hybrid of an immediate `ParentDir` reject +
/// a `Path::canonicalize()` fallback. `canonicalize()` requires the target to
/// exist on disk, so it silently skipped validation for missing files. The old
/// component check also incorrectly rejected legitimate `foo/../bar` paths
/// (no practical impact since tool dirs are flat, but semantically wrong).
fn normalize_within(
    base: &std::path::Path,
    relative: &str,
) -> Result<PathBuf, &'static str> {
    use std::path::Component;

    let mut stack: Vec<std::ffi::OsString> = Vec::new();

    for component in std::path::Path::new(relative).components() {
        match component {
            Component::Normal(seg) => stack.push(seg.to_os_string()),
            Component::CurDir => {} // "." — no-op
            Component::ParentDir => {
                // ".." — pop one level. Empty stack means we'd escape base.
                if stack.pop().is_none() {
                    return Err("traversal: path escapes tool version directory");
                }
            }
            // Leading "/" or a Windows drive prefix — always reject.
            Component::RootDir | Component::Prefix(_) => {
                return Err("traversal: absolute path in relative position");
            }
        }
    }

    let mut resolved = base.to_path_buf();
    for seg in &stack {
        resolved.push(seg);
    }

    // Invariant: by construction resolved always starts with base.
    // If this fires there is a bug in this function — treat as a security defect.
    debug_assert!(
        resolved.starts_with(base),
        "normalize_within: invariant violated — resolved path escaped base"
    );

    Ok(resolved)
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::normalize_within;
    use std::path::PathBuf;

    fn base() -> PathBuf {
        // Use a fixed synthetic path — normalize_within never touches the FS.
        PathBuf::from("/data/tools/abc123/versions/deadbeef00")
    }

    // ── Valid paths ───────────────────────────────────────────────────────────

    #[test]
    fn plain_file_resolves() {
        let p = normalize_within(&base(), "index.html").unwrap();
        assert_eq!(p, base().join("index.html"));
    }

    #[test]
    fn current_dir_prefix_ignored() {
        let p = normalize_within(&base(), "./index.html").unwrap();
        assert_eq!(p, base().join("index.html"));
    }

    #[test]
    fn nested_file_resolves() {
        let p = normalize_within(&base(), "assets/images/logo.png").unwrap();
        assert_eq!(p, base().join("assets/images/logo.png"));
    }

    #[test]
    fn parent_within_subdir_resolves() {
        // "foo/../bar" normalises to "bar" — stays inside base, valid.
        let p = normalize_within(&base(), "foo/../bar.txt").unwrap();
        assert_eq!(p, base().join("bar.txt"));
    }

    #[test]
    fn empty_relative_resolves_to_base() {
        let p = normalize_within(&base(), "").unwrap();
        assert_eq!(p, base());
    }

    // ── Traversal attempts — must all be rejected ─────────────────────────────

    #[test]
    fn traversal_double_dot_rejected() {
        assert!(
            normalize_within(&base(), "../../etc/passwd").is_err(),
            "../../etc/passwd must be rejected"
        );
    }

    #[test]
    fn traversal_single_dot_dot_rejected() {
        assert!(
            normalize_within(&base(), "../sibling-version/secret.html").is_err(),
            "../sibling-version/secret.html must be rejected"
        );
    }

    #[test]
    fn traversal_escape_after_subdir_rejected() {
        // Descend into "foo" then escape twice — net result would be above base.
        assert!(
            normalize_within(&base(), "foo/../../etc/passwd").is_err(),
            "foo/../../etc/passwd must be rejected"
        );
    }

    #[test]
    fn traversal_absolute_path_rejected() {
        assert!(
            normalize_within(&base(), "/etc/passwd").is_err(),
            "/etc/passwd must be rejected"
        );
    }

    #[test]
    fn traversal_deep_escape_rejected() {
        assert!(
            normalize_within(&base(), "a/b/c/../../../../../../../etc/passwd").is_err(),
            "deep escape must be rejected"
        );
    }

    #[test]
    fn traversal_dot_dot_only_rejected() {
        assert!(
            normalize_within(&base(), "..").is_err(),
            "bare .. must be rejected"
        );
    }
}
