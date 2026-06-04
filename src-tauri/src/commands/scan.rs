// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use regex::Regex;
use std::collections::HashSet;
use tauri::command;

use crate::models::{CapabilityFeature, DetectedCapability, NetCapability, ToolManifest};

// NOTE: This is a pattern-based static scan — a heuristic advisory layer.
// It CANNOT detect capabilities hidden behind:
//   • dynamic string construction: fetch("ht" + "tps://evil.com")
//   • obfuscated/minified code using indirect eval
//   • runtime code loaded via eval() or new Function()
//   • capabilities requested by injected third-party scripts (CDN)
// The runtime sandbox (CSP connect-src 'none', empty capability set) is the
// real security guarantee. The scan produces the human-readable permission
// badge and drives the derived manifest; it is not a security control.

/// Scan HTML/JS content and return detected capabilities.
pub fn scan_html(html: &str) -> Vec<DetectedCapability> {
    let mut detected: Vec<DetectedCapability> = Vec::new();
    let mut features: HashSet<CapabilityFeature> = HashSet::new();

    // Camera + microphone — getUserMedia takes a constraints object;
    // distinguishing audio-only vs video-only statically is unreliable,
    // so we flag both when we see the call.
    if html.contains("getUserMedia") {
        features.insert(CapabilityFeature::Camera);
        features.insert(CapabilityFeature::Microphone);
    }

    // Web USB
    if html.contains("navigator.usb") {
        features.insert(CapabilityFeature::Usb);
    }

    // Web Serial
    if html.contains("navigator.serial") {
        features.insert(CapabilityFeature::Serial);
    }

    // WebHID
    if html.contains("navigator.hid") {
        features.insert(CapabilityFeature::Hid);
    }

    // Web Bluetooth
    if html.contains("navigator.bluetooth") {
        features.insert(CapabilityFeature::Bluetooth);
    }

    // Geolocation — check both the API and common method names
    if html.contains("navigator.geolocation")
        || html.contains("getCurrentPosition")
        || html.contains("watchPosition")
    {
        features.insert(CapabilityFeature::Geolocation);
    }

    // Notifications
    if html.contains("new Notification") || html.contains("Notification.requestPermission") {
        features.insert(CapabilityFeature::Notifications);
    }

    // Storage APIs
    if html.contains("localStorage")
        || html.contains("sessionStorage")
        || html.contains("indexedDB")
        || html.contains("IndexedDB")
        || html.contains("caches.open")
        || html.contains("CacheStorage")
    {
        features.insert(CapabilityFeature::Storage);
    }

    // Add all simple features
    for f in features {
        detected.push(DetectedCapability::Feature(f));
    }

    // Network — detect usage and extract literal URL hosts
    let has_fetch = html.contains("fetch(") || html.contains("fetch (");
    let has_xhr = html.contains("XMLHttpRequest");
    let has_ws =
        html.contains("new WebSocket") || html.contains("new window.WebSocket");
    let has_eventsource = html.contains("new EventSource");

    if has_fetch || has_xhr || has_ws || has_eventsource {
        let mut hosts: HashSet<String> = HashSet::new();

        // Extract hosts from any http(s):// literal in the source
        // Captures: scheme://host+port (stops at /, ", ', whitespace, ))
        let url_re = Regex::new(r"https?://([a-zA-Z0-9\-._~:@!$&'*+,;=%]+)")
            .expect("valid regex");
        for cap in url_re.captures_iter(html) {
            if let Some(host_port) = cap.get(1) {
                let raw = host_port.as_str();
                // Strip port if present; take only hostname
                let host = raw.split(':').next().unwrap_or(raw).to_lowercase();
                // Exclude localhost / loopback — those aren't external hosts
                if !host.is_empty()
                    && host != "localhost"
                    && !host.starts_with("127.")
                    && !host.starts_with("::1")
                {
                    hosts.insert(host);
                }
            }
        }

        if hosts.is_empty() {
            // Network usage detected but no literal external hosts found —
            // mark as dynamic so the manifest is honest
            hosts.insert("(dynamic)".to_string());
        }

        let mut host_list: Vec<String> = hosts.into_iter().collect();
        host_list.sort();
        detected.push(DetectedCapability::Net(NetCapability { net: host_list }));
    }

    // Sort for stable output (features first, net last)
    detected.sort_by_key(|c| match c {
        DetectedCapability::Feature(_) => 0,
        DetectedCapability::Net(_) => 1,
    });

    detected
}

/// Extract a human-readable name from the HTML (title tag or synthesised).
pub fn extract_name(html: &str) -> String {
    let re = Regex::new(r"(?i)<title[^>]*>(.*?)</title>").expect("valid regex");
    if let Some(cap) = re.captures(html) {
        let raw = cap[1].trim().to_string();
        if !raw.is_empty() {
            return raw;
        }
    }
    "Unnamed Tool".to_string()
}

/// Extract a description from <meta name="description">.
pub fn extract_description(html: &str) -> String {
    let re = Regex::new(
        r#"(?i)<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']+)["']"#,
    )
    .expect("valid regex");
    if let Some(cap) = re.captures(html) {
        return cap[1].trim().to_string();
    }
    // Also try content-first ordering
    let re2 = Regex::new(
        r#"(?i)<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+name\s*=\s*["']description["']"#,
    )
    .expect("valid regex");
    if let Some(cap) = re2.captures(html) {
        return cap[1].trim().to_string();
    }
    String::new()
}

/// Extract a data URI icon from <link rel="icon">.
pub fn extract_icon(html: &str) -> Option<String> {
    let re = Regex::new(r#"(?i)<link[^>]+rel\s*=\s*["'](?:shortcut )?icon["'][^>]+href\s*=\s*["'](data:[^"']+)["']"#)
        .expect("valid regex");
    if let Some(cap) = re.captures(html) {
        return Some(cap[1].to_string());
    }
    None
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[command]
pub fn scan_capabilities(html: String) -> Vec<DetectedCapability> {
    scan_html(&html)
}

/// Map a derived manifest to a set of granted Tauri capability identifiers.
///
/// v0: always returns empty — deny-all regardless of what's detected.
/// The enforcement seam: in v1+, detected capabilities that the user has
/// approved map to real Tauri capability identifiers here. The tool window
/// is then opened with a dynamic capability set instead of the static
/// tool-default (empty) capability.
///
/// Example v1 mapping (not implemented):
///   Camera  → "camera:allow-open-media-stream"
///   Net     → inject <allowed-host> into a dynamic CSP header
#[command]
pub fn capabilities_for_manifest(_manifest: ToolManifest) -> Vec<String> {
    // v0-todo(v1): map manifest.detected → granted capability identifiers
    vec![]
}
