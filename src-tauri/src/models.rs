// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

use serde::{Deserialize, Serialize};

// ── Capability manifest ───────────────────────────────────────────────────────

/// A single detected capability from the static scan.
/// Serialises as either a plain string ("camera") or an object ({"net":[…]}).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum DetectedCapability {
    Feature(CapabilityFeature),
    Net(NetCapability),
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
        self.detected.iter().map(|c| c.to_plain_language()).collect()
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
