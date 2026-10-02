// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use regex::Regex;
use std::collections::HashSet;
use tauri::command;

use crate::models::{
    CapabilityFeature, DetectedCapability, NetCapability, SmartcardCapability, ToolManifest,
};
use crate::smartcard::is_valid_aid;

// NOTE: This is a pattern-based static scan — a heuristic advisory layer.
// It CANNOT detect capabilities hidden behind:
//   • dynamic string construction: fetch("ht" + "tps://evil.com")
//   • obfuscated/minified code using indirect eval
//   • runtime code loaded via eval() or new Function()
//   • capabilities requested by injected third-party scripts (CDN)
// The runtime sandbox (CSP connect-src 'none', empty capability set) is the
// real security guarantee. The scan produces the human-readable permission
// badge and drives the derived manifest; it is not a security control.

/// Is this string safe to emit as a host inside a Content-Security-Policy?
///
/// Every host that reaches the CSP builder originates in tool-authored HTML, so
/// this check is the only thing between an attacker-controlled string and a
/// security header. It is deliberately stricter than RFC 1123 — anything that is
/// not plainly a DNS hostname is rejected, in particular `;`, `,`, `'` and
/// whitespace, which would otherwise let a crafted URL restructure the policy.
///
/// Rejects IP literals with brackets, wildcards, userinfo, and ports; the
/// scanner strips ports before calling this, and approvals only ever contain
/// hosts the scanner produced.
pub fn is_valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

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
    let has_ws = html.contains("new WebSocket") || html.contains("new window.WebSocket");
    let has_eventsource = html.contains("new EventSource");

    if has_fetch || has_xhr || has_ws || has_eventsource {
        let mut hosts: HashSet<String> = HashSet::new();

        // Extract hosts from any http(s):// literal in the source
        // Captures: scheme://host+port (stops at /, ", ', whitespace, ))
        let url_re = Regex::new(r"https?://([a-zA-Z0-9\-._~:@!$&'*+,;=%]+)").expect("valid regex");
        // The SVG namespace declaration is an identifier, not an address. Without this a
        // tool that draws an SVG and also calls fetch() would be shown "www.w3.org" as a host
        // to approve. Only the exact `xmlns="http://www.w3.org/2000/svg"` attribute is
        // skipped: a fetch() of that URL, or any other w3.org URL, is still reported.
        let without_svg_ns = svg_namespace_re().replace_all(html, "");
        for cap in url_re.captures_iter(&without_svg_ns) {
            if let Some(host_port) = cap.get(1) {
                let raw = host_port.as_str();
                // Strip port if present; take only hostname
                let host = raw.split(':').next().unwrap_or(raw).to_lowercase();
                // Exclude localhost / loopback — those aren't external hosts.
                // Anything that is not a well-formed hostname is dropped rather
                // than surfaced: the capture class above admits characters that
                // are meaningful inside a CSP, and a malformed host must never
                // reach the manifest, the approval UI, or the policy builder.
                if !host.is_empty()
                    && host != "localhost"
                    && !host.starts_with("127.")
                    && !host.starts_with("::1")
                    && is_valid_host(&host)
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

    // Smart card — the Sanctum-only bridge, so detection keys off the API name
    // rather than a browser global. Which applet matters more than whether the
    // API is used at all, so pull literal AIDs out the same way hosts are
    // pulled out of fetch() calls above.
    if html.contains("sanctum.smartcard") || html.contains("sanctum[\"smartcard\"]") {
        let mut aids: HashSet<String> = HashSet::new();

        // `session.select("a0000006472f0001")` and `const AID = "…"` / `aid: "…"`
        for pattern in [
            r#"(?i)\.select\s*\(\s*["']([0-9a-f]{10,32})["']"#,
            // `const AID = "…"`, `aid: "…"`, `const FIDO_AID = "…"` — any
            // identifier containing "aid", since the value still has to look
            // like an AID to survive validation below.
            r#"(?i)\b[\w$]*aid[\w$]*\s*[:=]\s*["']([0-9a-f]{10,32})["']"#,
        ] {
            let re = Regex::new(pattern).expect("valid regex");
            for cap in re.captures_iter(html) {
                let aid = cap[1].to_lowercase();
                if is_valid_aid(&aid) {
                    aids.insert(aid);
                }
            }
        }

        if aids.is_empty() {
            aids.insert("(dynamic)".to_string());
        }
        let mut aid_list: Vec<String> = aids.into_iter().collect();
        aid_list.sort();
        detected.push(DetectedCapability::Smartcard(SmartcardCapability {
            smartcard: aid_list,
        }));
    }

    // Sort for stable output (features first, then net, then smart card)
    detected.sort_by_key(|c| match c {
        DetectedCapability::Feature(_) => 0,
        DetectedCapability::Net(_) => 1,
        DetectedCapability::Smartcard(_) => 2,
    });

    detected
}

fn svg_namespace_re() -> Regex {
    Regex::new(r#"xmlns\s*=\s*(?:"http://www\.w3\.org/2000/svg"|'http://www\.w3\.org/2000/svg')"#)
        .expect("valid regex")
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

/// Icons larger than this are ignored: the data URI is stored in the database and sent to
/// the UI with every library listing.
const MAX_ICON_BYTES: usize = 64 * 1024;

/// Extract a data URI icon from `<link rel="icon" href="data:...">`.
///
/// Attributes are read with their own quote character, so a value such as
/// `href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'..."` is not cut at
/// the first inner `'`. Attribute order does not matter.
pub fn extract_icon(html: &str) -> Option<String> {
    let tag_re = Regex::new(r#"(?is)<link\b(?:"[^"]*"|'[^']*'|[^>"'])*>"#).expect("valid regex");
    let attr_re = Regex::new(r#"(?is)([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .expect("valid regex");
    for tag in tag_re.find_iter(html) {
        let (mut rel, mut href) = (None, None);
        for c in attr_re.captures_iter(tag.as_str()) {
            let value = c.get(2).or_else(|| c.get(3)).map(|m| m.as_str());
            match c[1].to_ascii_lowercase().as_str() {
                "rel" => rel = value,
                "href" => href = value,
                _ => {}
            }
        }
        let is_icon =
            rel.is_some_and(|r| r.split_whitespace().any(|t| t.eq_ignore_ascii_case("icon")));
        if let (true, Some(h)) = (is_icon, href) {
            let h = h.trim();
            let is_data = h.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("data:"));
            if is_data && h.len() <= MAX_ICON_BYTES {
                return Some(h.to_string());
            }
        }
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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Hosts extracted from a scan, or None when no network use was detected.
    fn scanned_hosts(html: &str) -> Option<Vec<String>> {
        scan_html(html).into_iter().find_map(|c| match c {
            DetectedCapability::Net(n) => Some(n.net),
            _ => None,
        })
    }

    // ── is_valid_host ─────────────────────────────────────────────────────────

    #[test]
    fn ordinary_hostnames_are_valid() {
        for host in [
            "example.com",
            "api.example.com",
            "my-api.example.co.uk",
            "xn--80ak6aa92e.com",
            "a.b.c.d.e.f",
            "host123",
        ] {
            assert!(is_valid_host(host), "rejected valid host: {host}");
        }
    }

    #[test]
    fn csp_metacharacters_are_invalid() {
        // These are the characters that make CSP injection possible.
        for host in [
            "evil.com;report-uri",
            "evil.com,default-src",
            "evil.com script-src",
            "evil.com'",
            "evil.com\"",
            "evil.com*",
            "evil.com/path",
            "evil.com:443",
            "evil.com%20x",
            "evil.com\nx",
        ] {
            assert!(!is_valid_host(host), "accepted dangerous host: {host}");
        }
    }

    #[test]
    fn malformed_dns_labels_are_invalid() {
        for host in [
            "",
            ".",
            "..",
            ".example.com",
            "example.com.",
            "a..b",
            "-x.com",
            "x-.com",
        ] {
            assert!(!is_valid_host(host), "accepted malformed host: {host}");
        }
    }

    #[test]
    fn overlong_names_and_labels_are_invalid() {
        assert!(!is_valid_host(&"a".repeat(64)));
        assert!(is_valid_host(&"a".repeat(63)));
        let long = std::iter::repeat_n("abcdefgh", 40)
            .collect::<Vec<_>>()
            .join(".");
        assert!(long.len() > 253);
        assert!(!is_valid_host(&long));
    }

    // ── Host extraction ───────────────────────────────────────────────────────

    #[test]
    fn the_svg_namespace_is_not_a_network_host() {
        let html = r#"<script>fetch("https://api.example.com/v1");
            el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
            const i = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";</script>"#;
        assert_eq!(
            scanned_hosts(html).unwrap(),
            vec!["api.example.com".to_string()]
        );
    }

    #[test]
    fn other_w3_urls_and_real_requests_to_it_are_still_reported() {
        let ns_only =
            r#"<script>fetch(u); x = '<svg xmlns="http://www.w3.org/2000/svg">';</script>"#;
        assert_eq!(
            scanned_hosts(ns_only).unwrap(),
            vec!["(dynamic)".to_string()]
        );
        let real = r#"<script>fetch("http://www.w3.org/2000/svg")</script>"#;
        assert_eq!(scanned_hosts(real).unwrap(), vec!["www.w3.org".to_string()]);
        let xhtml = r#"<script>fetch(u); x = 'xmlns="http://www.w3.org/1999/xhtml"';</script>"#;
        assert_eq!(
            scanned_hosts(xhtml).unwrap(),
            vec!["www.w3.org".to_string()]
        );
    }

    #[test]
    fn literal_host_is_extracted() {
        let hosts = scanned_hosts(r#"<script>fetch("https://api.example.com/v1")</script>"#)
            .expect("net capability detected");
        assert_eq!(hosts, vec!["api.example.com"]);
    }

    #[test]
    fn port_is_stripped_and_host_kept() {
        let hosts = scanned_hosts(r#"<script>fetch("https://api.example.com:8443/v1")</script>"#)
            .expect("net capability detected");
        assert_eq!(hosts, vec!["api.example.com"]);
    }

    #[test]
    fn crafted_host_never_reaches_the_manifest() {
        // The capture class admits ';' — validation must drop the result rather
        // than let it flow through to approvals and the CSP builder.
        let hosts = scanned_hosts(r#"<script>fetch("https://evil.com;report-uri")</script>"#)
            .expect("net capability detected");
        assert_eq!(
            hosts,
            vec!["(dynamic)"],
            "crafted host survived validation: {hosts:?}"
        );
    }

    #[test]
    fn loopback_hosts_are_not_reported_as_external() {
        let hosts = scanned_hosts(r#"<script>fetch("http://localhost:3000/x")</script>"#)
            .expect("net capability detected");
        assert_eq!(hosts, vec!["(dynamic)"]);
    }

    #[test]
    fn network_use_without_literal_hosts_is_marked_dynamic() {
        let hosts = scanned_hosts(r#"<script>fetch(base + path)</script>"#)
            .expect("net capability detected");
        assert_eq!(hosts, vec!["(dynamic)"]);
    }

    #[test]
    fn no_network_use_yields_no_net_capability() {
        assert!(scanned_hosts("<p>static page</p>").is_none());
    }

    // ── Smart card detection ──────────────────────────────────────────────────

    /// AIDs extracted from a scan, or None when no smart card use was detected.
    fn scanned_aids(html: &str) -> Option<Vec<String>> {
        scan_html(html).into_iter().find_map(|c| match c {
            DetectedCapability::Smartcard(s) => Some(s.smartcard),
            _ => None,
        })
    }

    #[test]
    fn smartcard_api_use_is_detected() {
        let aids = scanned_aids(r#"<script>await sanctum.smartcard.listReaders()</script>"#)
            .expect("smart card capability detected");
        assert_eq!(aids, vec!["(dynamic)"]);
    }

    #[test]
    fn a_page_that_never_touches_the_api_declares_nothing() {
        assert!(scanned_aids("<p>static page</p>").is_none());
        // The word alone is not the API — no false positive from prose.
        assert!(scanned_aids("<p>this tool reads a smartcard</p>").is_none());
    }

    #[test]
    fn literal_aid_in_select_is_extracted() {
        let aids =
            scanned_aids(r#"<script>sanctum.smartcard; s.select("A0000006472F0001")</script>"#)
                .expect("detected");
        assert_eq!(aids, vec!["a0000006472f0001"]);
    }

    #[test]
    fn aid_constant_is_extracted() {
        let aids =
            scanned_aids(r#"<script>const AID = "a0000006472f0001"; sanctum.smartcard;</script>"#)
                .expect("detected");
        assert_eq!(aids, vec!["a0000006472f0001"]);
    }

    #[test]
    fn a_prefixed_aid_constant_is_extracted() {
        // The name tools actually use for it.
        let aids = scanned_aids(
            r#"<script>const FIDO_AID = 'a0000006472f0001'; sanctum.smartcard;</script>"#,
        )
        .expect("detected");
        assert_eq!(aids, vec!["a0000006472f0001"]);
    }

    #[test]
    fn every_literal_applet_is_listed() {
        let aids = scanned_aids(
            r#"<script>sanctum.smartcard;
               s.select("a0000006472f0001"); s.select("a000000308000010000100");</script>"#,
        )
        .expect("detected");
        assert_eq!(
            aids,
            vec!["a000000308000010000100", "a0000006472f0001"],
            "both applets must reach the approval prompt"
        );
    }

    #[test]
    fn a_runtime_built_aid_is_marked_dynamic() {
        let aids = scanned_aids(r#"<script>sanctum.smartcard; s.select(prefix + rest)</script>"#)
            .expect("detected");
        assert_eq!(aids, vec!["(dynamic)"]);
    }

    #[test]
    fn a_malformed_aid_literal_does_not_become_an_approval() {
        // Too short to be an AID — the scan must not offer it for approval.
        let aids = scanned_aids(r#"<script>sanctum.smartcard; s.select("a0000006")</script>"#)
            .expect("detected");
        assert_eq!(aids, vec!["(dynamic)"]);
    }

    // ── Shipped examples ──────────────────────────────────────────────────────

    /// The Shamir example asks for nothing: no storage, no network, no devices. The approval
    /// screen must stay empty, so any string that widens it (even in a comment) fails CI.
    /// Its icon must also survive extraction, since it is a data URI with inner quotes.
    #[test]
    fn shamir_example_asks_for_nothing() {
        let html = include_str!("../../../examples/shamir/index.html");
        let caps = scan_html(html);
        assert!(caps.is_empty(), "unexpected capabilities: {caps:?}");
        let icon = extract_icon(html).expect("example has a complete icon");
        assert!(icon.starts_with("data:image/svg+xml"), "{icon}");
    }

    /// The OTP vault example asks for exactly two things: its own storage and
    /// the YubiKey OATH applet. A regression here changes what users are asked
    /// to approve, so it is pinned.
    #[test]
    fn otp_vault_example_asks_for_storage_and_oath_only() {
        let html = include_str!("../../../examples/otp-vault/index.html");
        let caps = scan_html(html);
        assert!(
            scanned_hosts(html).is_none(),
            "example must not request network: {caps:?}"
        );
        assert!(caps.contains(&DetectedCapability::Feature(CapabilityFeature::Storage)));
        assert_eq!(
            scanned_aids(html).expect("smart card detected"),
            vec!["a0000005272101"]
        );
        assert_eq!(caps.len(), 2, "unexpected capabilities: {caps:?}");
    }

    // ── Icon extraction ───────────────────────────────────────────────────────

    #[test]
    fn a_data_uri_icon_with_inner_single_quotes_is_not_truncated() {
        let html = r#"<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 4 4'%3E%3C/svg%3E">"#;
        let icon = extract_icon(html).expect("icon");
        assert!(icon.ends_with("%3C/svg%3E"), "{icon}");
        assert!(icon.contains("viewBox='0 0 4 4'"));
    }

    #[test]
    fn single_quoted_attribute_may_contain_double_quotes() {
        let html = r#"<link rel='icon' href='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'>"#;
        let icon = extract_icon(html).expect("icon");
        assert!(icon.ends_with("/>"), "{icon}");
    }

    #[test]
    fn attribute_order_and_shortcut_icon_are_accepted() {
        assert!(
            extract_icon(r#"<link href="data:image/png;base64,AAAA" rel="shortcut icon">"#)
                .is_some()
        );
        assert!(extract_icon(r#"<LINK REL="ICON" HREF="DATA:image/png;base64,AAAA" />"#).is_some());
    }

    #[test]
    fn only_inline_data_icons_are_taken() {
        assert!(extract_icon(r#"<link rel="icon" href="https://x.test/i.png">"#).is_none());
        assert!(extract_icon(r#"<link rel="icon" href="/i.png">"#).is_none());
        assert!(extract_icon(r#"<link rel="stylesheet" href="data:text/css,a{}">"#).is_none());
        assert!(
            extract_icon(r#"<link rel="apple-touch-icon" href="data:image/png;base64,AAAA">"#)
                .is_none()
        );
        assert!(extract_icon("<p>no links</p>").is_none());
    }

    #[test]
    fn the_icon_link_is_found_among_other_links() {
        let html = r#"<link rel="preload" href="data:x"><link rel="icon" href="data:image/png;base64,AAAA">"#;
        assert_eq!(extract_icon(html).unwrap(), "data:image/png;base64,AAAA");
    }

    #[test]
    fn an_oversized_icon_is_ignored() {
        let big = "A".repeat(MAX_ICON_BYTES + 1);
        let html = format!(r#"<link rel="icon" href="data:image/png;base64,{big}">"#);
        assert!(extract_icon(&html).is_none());
    }

    #[test]
    fn the_otp_vault_example_icon_is_complete() {
        let html = include_str!("../../../examples/otp-vault/index.html");
        let icon = extract_icon(html).expect("example has an icon");
        assert!(icon.len() > 100, "icon was truncated: {icon}");
        assert!(icon.ends_with("%3E"), "{icon}");
    }
}
