// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use serde::{Deserialize, Serialize};

// ── Capability manifest ───────────────────────────────────────────────────────

/// A single detected capability from the static scan.
/// Serialises as either a plain string ("camera") or an object ({"net":[…]},
/// {"smartcard":[…]}).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum DetectedCapability {
    Feature(CapabilityFeature),
    Net(NetCapability),
    /// Smart card applets the tool asks to talk to, as AID hex strings.
    /// Object-shaped like `Net` for the same reason: the approval is per
    /// destination (there, a host; here, an applet), not a blanket yes.
    Smartcard(SmartcardCapability),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityFeature {
    Camera,
    Microphone,
    Geolocation,
    Notifications,
    Usb,
    Serial,
    Hid,
    Bluetooth,
    Storage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetCapability {
    pub net: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SmartcardCapability {
    /// Application identifiers (ISO 7816 AIDs) as lowercase hex, or the single
    /// entry `(dynamic)` when the scan could not resolve which applet is used.
    pub smartcard: Vec<String>,
}

/// Well-known applets, so the approval prompt says "FIDO2 / WebAuthn" instead
/// of a bare hex string. Unknown AIDs are shown as hex — Sanctum does not
/// guess, and an unfamiliar applet is exactly the case the user should read.
pub fn known_applet_name(aid: &str) -> Option<&'static str> {
    match aid {
        "a0000006472f0001" => Some("FIDO2 / WebAuthn (CTAP)"),
        "a000000308000010000100" => Some("PIV (smart card identity)"),
        "d27600012401" => Some("OpenPGP card"),
        "a000000527471117" => Some("YubiKey OTP"),
        "a0000005272101" => Some("OATH (TOTP/HOTP)"),
        _ => None,
    }
}

impl DetectedCapability {
    /// Human-readable plain-language description for display in the UI.
    pub fn to_plain_language(&self) -> String {
        match self {
            DetectedCapability::Feature(f) => match f {
                CapabilityFeature::Camera => "use your camera".into(),
                CapabilityFeature::Microphone => "use your microphone".into(),
                CapabilityFeature::Geolocation => "access your location".into(),
                CapabilityFeature::Notifications => "send desktop notifications".into(),
                CapabilityFeature::Usb => "access USB devices".into(),
                CapabilityFeature::Serial => "access serial ports".into(),
                CapabilityFeature::Hid => "access HID input devices".into(),
                CapabilityFeature::Bluetooth => "access Bluetooth devices".into(),
                CapabilityFeature::Storage => "read/write local browser storage".into(),
            },
            DetectedCapability::Net(n) => {
                let hosts = &n.net;
                if hosts.is_empty() {
                    "make network requests".into()
                } else if hosts.len() == 1 && hosts[0] == "(dynamic)" {
                    "make network requests (destinations determined at runtime)".into()
                } else {
                    format!("contact: {}", hosts.join(", "))
                }
            }
            DetectedCapability::Smartcard(s) => {
                let aids = &s.smartcard;
                if aids.is_empty() {
                    "talk to a smart card".into()
                } else if aids.len() == 1 && aids[0] == "(dynamic)" {
                    "talk to a smart card (applet determined at runtime)".into()
                } else {
                    let named: Vec<String> = aids
                        .iter()
                        .map(|a| match known_applet_name(a) {
                            Some(n) => format!("{n} [{a}]"),
                            None => format!("unknown applet [{a}]"),
                        })
                        .collect();
                    format!("talk to your smart card: {}", named.join(", "))
                }
            }
        }
    }
}

/// Per-version derived manifest — stored as JSON next to the version file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolManifest {
    pub name: String,
    pub version: String,
    pub checksum: String,
    pub detected: Vec<DetectedCapability>,
    /// Ed25519 signature over the manifest JSON (base64url). Always null in v0.
    pub signature: Option<String>,
}

impl ToolManifest {
    /// Returns a list of plain-language capability strings for display.
    pub fn plain_language_summary(&self) -> Vec<String> {
        if self.detected.is_empty() {
            return vec!["nothing beyond rendering HTML".into()];
        }
        self.detected
            .iter()
            .map(|c| c.to_plain_language())
            .collect()
    }
}

// ── Tool records (as returned by commands) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub icon_data: Option<String>,
    pub current_ver: Option<String>,
    /// User-approved capabilities for this tool. Subset of the current version's
    /// `detected` list. Drives dynamic CSP at run time — only approved capabilities
    /// are granted; everything else remains denied.
    pub approvals: Vec<DetectedCapability>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionRecord {
    pub id: String,
    pub tool_id: String,
    pub version_num: i32,
    pub file_size: i64,
    pub checksum: String,
    pub manifest: ToolManifest,
    pub quarantined: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolWithVersion {
    pub tool: ToolRecord,
    pub current_version: Option<VersionRecord>,
    pub all_versions: Vec<VersionRecord>,
}
