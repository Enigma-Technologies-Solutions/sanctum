// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

// Mirror of Rust models — keep in sync with src-tauri/src/models.rs

export type CapabilityFeature =
  | "camera"
  | "microphone"
  | "geolocation"
  | "notifications"
  | "usb"
  | "serial"
  | "hid"
  | "bluetooth"
  | "storage";

export type DetectedCapability =
  | CapabilityFeature
  | { net: string[] }
  /** Smart card applets, as ISO 7816 AID hex strings, or ["(dynamic)"]. */
  | { smartcard: string[] };

/** Applets we can name in the approval prompt. Anything else is shown as hex. */
const KNOWN_APPLETS: Record<string, string> = {
  a0000006472f0001: "FIDO2 / WebAuthn (CTAP)",
  a000000308000010000100: "PIV (smart card identity)",
  d27600012401: "OpenPGP card",
  a000000527471117: "YubiKey OTP",
  a0000005272101: "OATH (TOTP/HOTP)",
};

export function appletLabel(aid: string): string {
  return KNOWN_APPLETS[aid] ?? "unknown applet";
}

export interface ToolManifest {
  name: string;
  version: string;
  checksum: string;
  detected: DetectedCapability[];
  signature: string | null;
}

export interface ToolRecord {
  id: string;
  name: string;
  description: string;
  tags: string[];
  icon_data: string | null;
  current_ver: string | null;
  /** User-approved capabilities. Subset of current version's detected[]. Drives CSP at run time. */
  approvals: DetectedCapability[];
  created_at: number;
  updated_at: number;
}

export interface VersionRecord {
  id: string;
  tool_id: string;
  version_num: number;
  file_size: number;
  checksum: string;
  manifest: ToolManifest;
  quarantined: boolean;
  created_at: number;
}

/** A pending signed update, as reported by the Rust updater command. */
export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
}

export interface ToolWithVersion {
  tool: ToolRecord;
  current_version: VersionRecord | null;
  all_versions: VersionRecord[];
}

export interface IngestResult {
  tool: ToolRecord;
  version: VersionRecord;
  isNewTool: boolean;
}

/** Where a version came from when it was installed from a signed .sanctum bundle. */
export interface ProvenanceRecord {
  versionId: string;
  appId: string;
  publisherKey: string;
  publisherName: string | null;
  /** "verified" (signer is a trust anchor) or "unknown_signer". Neither grants any permission. */
  trust: "verified" | "unknown_signer";
  name: string;
  version: string;
  issuedAt: number;
  installedAt: number;
}

export interface BundleInstall extends IngestResult {
  provenance: ProvenanceRecord;
  warnings: string[];
}

/** Organisation policy state, from the admin-managed policy file. */
export interface PolicyStatus {
  /** A policy file is present (valid or not). */
  managed: boolean;
  /** Number of pinned checksums when pinning is in use. */
  pinnedCount: number | null;
  /** Set when the policy cannot be applied. Tools are blocked until it is fixed. */
  error: string | null;
}

export interface MetadataUpdate {
  name?: string;
  description?: string;
  tags?: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function capabilityToPlain(cap: DetectedCapability): string {
  if (typeof cap === "string") {
    const map: Record<CapabilityFeature, string> = {
      camera: "use your camera",
      microphone: "use your microphone",
      geolocation: "access your location",
      notifications: "send desktop notifications",
      usb: "access USB devices",
      serial: "access serial ports",
      hid: "access HID input devices",
      bluetooth: "access Bluetooth devices",
      storage: "read/write local browser storage",
    };
    return map[cap as CapabilityFeature] ?? cap;
  }
  if ("smartcard" in cap) {
    const aids = cap.smartcard;
    if (!aids.length) return "talk to a smart card";
    if (aids.length === 1 && aids[0] === "(dynamic)")
      return "talk to a smart card (applet determined at runtime)";
    return `talk to your smart card: ${aids
      .map((a) => `${appletLabel(a)} [${a}]`)
      .join(", ")}`;
  }
  const hosts = cap.net;
  if (!hosts.length) return "make network requests";
  if (hosts.length === 1 && hosts[0] === "(dynamic)")
    return "make network requests (destinations determined at runtime)";
  return `contact: ${hosts.join(", ")}`;
}

export function manifestSummary(manifest: ToolManifest | null | undefined): string {
  if (!manifest || manifest.detected.length === 0) return "nothing beyond rendering HTML";
  return manifest.detected.map(capabilityToPlain).join("; ");
}

export function shortSha(checksum: string): string {
  const hex = checksum.replace("sha256:", "");
  return hex.slice(0, 12);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}
