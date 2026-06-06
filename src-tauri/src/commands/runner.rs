// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use sqlx::Row;
use tauri::{command, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::versioning::hash_bytes_hex;
use crate::db::DbState;
use crate::models::{CapabilityFeature, DetectedCapability, ToolManifest};
use crate::ActiveToolPaths;
use crate::AppDataDir;

/// Initialization script injected into every tool window BEFORE the tool's
/// HTML is parsed. Removes Tauri IPC globals so tools have zero OS bridge.
const BLOCK_TAURI_IPC: &str = r#"
(function () {
  'use strict';
  const BLOCKED = ['__TAURI__', '__TAURI_IPC__', '__TAURI_INTERNALS__',
                   '__TAURI_INVOKE__', 'ipc', '__TAURI_METADATA__'];
  for (const k of BLOCKED) {
    try {
      Object.defineProperty(window, k, {
        get: function () { return undefined; },
        set: function () {},
        configurable: false,
        enumerable: false,
      });
    } catch (_) {}
  }
})();
"#;

/// CSP with everything denied — applied when no capabilities are approved.
const BASELINE_CSP: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self' 'unsafe-inline'; ",
    "style-src 'self' 'unsafe-inline'; ",
    "img-src 'self' data: blob:; ",
    "font-src 'self' data:; ",
    "connect-src 'none'; ",
    "media-src 'none'; ",
    "worker-src 'none'; ",
    "frame-src 'none'; ",
    "object-src 'none'; ",
    "base-uri 'self'"
);

/// Build a dynamic Content-Security-Policy for a tool window based on the
/// capabilities the user has explicitly approved.
///
/// Security model:
///  - Baseline: deny-all for every fetch-type directive.
///  - Network: approved hosts added to connect-src (https + wss), style-src,
///    font-src, and img-src so CSS/font CDNs work alongside API endpoints.
///  - Camera/mic: media-src relaxed to allow getUserMedia streams.
///  - Storage: localStorage/IndexedDB always available at the same-origin level;
///    no CSP directive controls these — they're gated by origin isolation.
///  - Geolocation/Notifications/USB/Serial/HID/Bluetooth: browser permissions
///    not controlled by CSP. Granting them requires device_broker (v1+ seam).
///
/// v1-todo: per-host granularity on net approvals (currently all-or-nothing).
/// v1-todo: 'unsafe-eval' as an opt-in for tools that use dynamic code.
pub fn build_tool_csp(approvals: &[DetectedCapability]) -> String {
    // Extract approved net hosts (excluding the "(dynamic)" sentinel)
    let net_hosts: Vec<String> = approvals
        .iter()
        .filter_map(|cap| {
            if let DetectedCapability::Net(n) = cap {
                Some(n.net.clone())
            } else {
                None
            }
        })
        .flatten()
        .filter(|h| h != "(dynamic)")
        .collect();

    let allow_camera = approvals
        .iter()
        .any(|c| matches!(c, DetectedCapability::Feature(CapabilityFeature::Camera)));
    let allow_mic = approvals.iter().any(|c| {
        matches!(
            c,
            DetectedCapability::Feature(CapabilityFeature::Microphone)
        )
    });

    if net_hosts.is_empty() && !allow_camera && !allow_mic {
        return BASELINE_CSP.to_string();
    }

    // Build https:// and wss:// variants for each approved host so fetch,
    // WebSocket, and CDN requests all work under the same approval.
    let host_entries: Vec<String> = net_hosts
        .iter()
        .flat_map(|h| [format!("https://{}", h), format!("wss://{}", h)])
        .collect();
    let hosts = host_entries.join(" ");

    let connect_src = if net_hosts.is_empty() {
        "'none'".to_string()
    } else {
        hosts.clone()
    };

    // Relax style-src and font-src so CSS/font CDNs (e.g. Google Fonts) work
    // when their domains are in the approved host list.
    let style_src = if net_hosts.is_empty() {
        "'self' 'unsafe-inline'".to_string()
    } else {
        format!("'self' 'unsafe-inline' {}", hosts)
    };
    let font_src = if net_hosts.is_empty() {
        "'self' data:".to_string()
    } else {
        format!("'self' data: {}", hosts)
    };
    let img_src = if net_hosts.is_empty() {
        "'self' data: blob:".to_string()
    } else {
        format!("'self' data: blob: {}", hosts)
    };

    // Camera / microphone — getUserMedia requires a secure context (provided by
    // the custom protocol) and a permissive media-src.
    let media_src = if allow_camera || allow_mic {
        "'self' blob: mediastream:"
    } else {
        "'none'"
    };

    format!(
        "default-src 'self'; \
         script-src 'self' 'unsafe-inline'; \
         style-src {style_src}; \
         img-src {img_src}; \
         font-src {font_src}; \
         connect-src {connect_src}; \
         media-src {media_src}; \
         worker-src 'none'; \
         frame-src 'none'; \
         object-src 'none'; \
         base-uri 'self'"
    )
}

/// Build a human-readable summary of what a tool is actually allowed to do,
/// based on its approved (not just detected) capabilities.
fn approved_summary(approvals: &[DetectedCapability]) -> String {
    if approvals.is_empty() {
        return "sandboxed — no network, no device access".to_string();
    }
    approvals
        .iter()
        .map(|c| c.to_plain_language())
        .collect::<Vec<_>>()
        .join("; ")
}

#[command]
pub async fn open_tool_window(
    app: tauri::AppHandle,
    db: tauri::State<'_, DbState>,
    data_dir: tauri::State<'_, AppDataDir>,
    paths: tauri::State<'_, ActiveToolPaths>,
    tool_id: String,
) -> Result<(), String> {
    // 1. Load current version + user approvals
    let tool_row = sqlx::query("SELECT name, current_ver, approvals FROM tools WHERE id = $1")
        .bind(&tool_id)
        .fetch_optional(&db.0)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Tool not found: {tool_id}"))?;

    let tool_name: String = tool_row.try_get("name").unwrap_or_else(|_| "Tool".into());
    let current_ver: Option<String> = tool_row.try_get("current_ver").unwrap_or(None);
    let approvals_json: String = tool_row
        .try_get("approvals")
        .unwrap_or_else(|_| "[]".into());
    let sha = current_ver.ok_or("Tool has no version to run")?;

    let approvals: Vec<DetectedCapability> =
        serde_json::from_str(&approvals_json).unwrap_or_default();

    // 2. Integrity check — re-hash the stored file
    let version_dir = data_dir
        .0
        .join("tools")
        .join(&tool_id)
        .join("versions")
        .join(&sha);
    let html_path = version_dir.join("index.html");

    let content = std::fs::read(&html_path).map_err(|e| format!("Cannot read tool file: {e}"))?;

    let actual_sha = hash_bytes_hex(&content);
    if actual_sha != sha {
        sqlx::query("UPDATE tool_versions SET quarantined = 1 WHERE id = $1")
            .bind(&sha)
            .execute(&db.0)
            .await
            .ok();
        return Err(format!(
            "Integrity check failed for tool '{tool_name}'. \
             Expected sha256:{sha}, got sha256:{actual_sha}. \
             Tool quarantined."
        ));
    }

    // 3. Check not already quarantined
    let ver_row = sqlx::query("SELECT quarantined, manifest FROM tool_versions WHERE id = $1")
        .bind(&sha)
        .fetch_one(&db.0)
        .await
        .map_err(|e| e.to_string())?;

    let quarantined: i32 = ver_row.try_get("quarantined").unwrap_or(0);
    if quarantined != 0 {
        return Err(format!("Tool '{tool_name}' is quarantined — will not run."));
    }

    let manifest_json: String = ver_row.try_get("manifest").map_err(|e| e.to_string())?;
    let _manifest: ToolManifest =
        serde_json::from_str(&manifest_json).map_err(|e| e.to_string())?;

    // 4. Build dynamic CSP from user approvals (only capabilities that were
    //    actually detected in this version are meaningful; extras are harmless).
    let csp = build_tool_csp(&approvals);

    // 5. Register path + CSP in shared state for the protocol handler
    {
        let mut map = paths.0.lock().unwrap();
        map.insert(tool_id.clone(), (version_dir, csp));
    }

    // 6. Window label and custom-protocol URL
    let label = format!("tool-{}", tool_id);
    let url_str = format!("sanctum-tool://tool-{}/index.html", tool_id);
    let url = url::Url::parse(&url_str).map_err(|e| format!("Bad URL: {e}"))?;

    // Focus existing window instead of re-creating
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // 7. Build window title showing APPROVED (not just detected) capabilities
    let summary = approved_summary(&approvals);
    let title = format!(
        "{} — {} | ⚠ Third-party tool — not verified by Sanctum",
        tool_name, summary,
    );

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::CustomProtocol(url))
        .title(title)
        .initialization_script(BLOCK_TAURI_IPC)
        .inner_size(1024.0, 768.0)
        .min_inner_size(400.0, 300.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}
