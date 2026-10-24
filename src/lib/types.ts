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
  /** `agent` for a tool written by an AI agent in Sanctum. Where it came from, never a sign of safety. */
  origin?: string | null;
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
  /** Set when the current version was installed from a signed .sanctum bundle. */
  provenance: ProvenanceRecord | null;
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

/** A publisher key this build recognises, from src-tauri/src/trust.rs. */
export interface TrustAnchorInfo {
  name: string;
  keyId: string;
}

/** How a registry's signer is trusted: a compiled-in key, or a key the user pinned. */
export type RegistryTrust = "anchored" | "pinned";

/** A registry the user added, from the cached and re-verified catalogue. */
export interface RegistrySummary {
  id: string;
  name: string;
  kind: "public" | "licensed";
  baseUrl: string;
  trust: RegistryTrust;
  /** Who the signature identifies, or "Key pinned by you". */
  publisher: string;
  signer: string;
  appCount: number;
  serial: number;
  issuedAt: number;
  expires: number;
  /** Past its expiry. Browsing still works; say so. */
  stale: boolean;
  revocations: { serial: number; expires: number; stale: boolean } | null;
  addedAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
}

export type RegistryIndexOutcome =
  | { state: "unchanged" }
  | { state: "updated"; fromSerial: number; toSerial: number };

export type RegistryRevocationsOutcome =
  | { state: "notListed" }
  | { state: "unchanged" }
  | { state: "updated" }
  | { state: "failed"; message: string };

export interface RegistryRefreshReport {
  index: RegistryIndexOutcome;
  revocations: RegistryRevocationsOutcome;
  registry: RegistrySummary;
}

export interface RegistryCatalogVersion {
  version: string;
  publishedAt: number;
  /** What the publisher declares. The approval screen, not this, grants anything. */
  declared: DetectedCapability[];
  size: number;
  revoked: boolean;
}

export type RegistryInstallState =
  | "notInstalled"
  | "installed"
  | "updateAvailable"
  /** Listed but not installable by this version of Sanctum. */
  | "licensed";

export interface RegistryCatalogApp {
  appId: string;
  name: string;
  summary: string;
  publisherKey: string;
  publisherName: string;
  latest: string;
  versions: RegistryCatalogVersion[];
  installedVersion: string | null;
  state: RegistryInstallState;
  latestRevoked: boolean;
}

export interface RegistryCatalogue {
  registryId: string;
  registryName: string;
  stale: boolean;
  revocationsStale: boolean;
  apps: RegistryCatalogApp[];
}

/** Installing never approves anything: `install.tool.approvals` is empty for a new tool. */
export type RegistryInstallOutcome =
  | { state: "installed"; install: BundleInstall; notes: string[] }
  | { state: "alreadyInstalled"; version: string };

export type RegistryBatchItem = { appId: string; name: string } & (
  | { state: "installed"; toolId: string; version: string; trust: string }
  | { state: "alreadyInstalled"; version: string }
  | { state: "failed"; code: string; message: string }
);

export interface RegistryChangelogEntry {
  version: string;
  date: string;
  changes: { type: "added" | "changed" | "fixed" | "security" | "removed"; text: string }[];
}

export interface RegistryScreenshot {
  alt: string;
  width: number;
  height: number;
  /** A data: URL of the verified image, or null if it failed its check. */
  dataUrl: string | null;
  error: string | null;
}

/** An app's detail page. Every file was checked against the signed index in Rust. */
export interface RegistryAppDetail {
  appId: string;
  name: string;
  description: string;
  homepage: string | null;
  source: string | null;
  license: string | null;
  changelog: RegistryChangelogEntry[];
  /** Untrusted Markdown. Render it with parseMarkdown, never as HTML. */
  manual: string | null;
  manualError: string | null;
  screenshots: RegistryScreenshot[];
  /** A data: URL. Show it only through an <img>. */
  icon: string | null;
  iconError: string | null;
}

/**
 * What a registry command rejects with. `code` is stable. For "untrusted_signer" the signer
 * fields are set: show the key and ask before calling addRegistry again with it pinned.
 */
export interface RegistryCommandError {
  code: string;
  message: string;
  signer: string | null;
  registryId: string | null;
  registryName: string | null;
}

/** Whether the agent can be set up here. Mirrors `AgentSetup` in src-tauri/src/agent/commands.rs. */
export interface AgentSetup {
  /** Sanctum has a Codex build for this computer. */
  supported: boolean;
  /** Codex is already downloaded. */
  installed: boolean;
  /** Size of the first-use download in megabytes. */
  downloadMb: number;
}

/** Progress of the first-use download of Codex (the `agent-download` event). */
export interface AgentDownload {
  done: number;
  total: number;
}

/** Who is signed in to the agent (Codex). Mirrors `AgentAccount` in src-tauri/src/agent/commands.rs. */
export interface AgentAccount {
  signedIn: boolean;
  email: string | null;
  /** Plan name such as "Pro", ready to show. */
  plan: string | null;
}

/** What a build session reports when it opens. Mirrors `ChatStarted` in src-tauri/src/agent/commands.rs. */
export interface ChatStarted {
  model: string | null;
  version: string | null;
  /** The private work folder, with the home folder shown as `~`. */
  directory: string;
  /** What Codex was given to read before the first message. */
  sources: ChatSource[];
}

/** One thing Codex was given to read. Mirrors `SourceEntry` in src-tauri/src/agent/commands.rs. */
export interface ChatSource {
  kind: "app" | "guide" | "instructions";
  title: string;
  detail: string;
  /** The library app, for `app`. */
  toolId: string | null;
}

/** An app the person asked to change while the Create window was open (`agent-source` event). */
export interface SourceRequest {
  toolId: string;
  name: string;
}

/** One draft of a conversation. Mirrors `Entry` in src-tauri/src/agent/history.rs. */
export interface DraftVersion {
  sha: string;
  number: number;
  size: number;
  /** Unix seconds. */
  at: number;
  /** The file the conversation started from, not written by Codex. */
  loaded: boolean;
  /** This is the file in the work folder now. */
  current: boolean;
  name: string;
}

/** The draft the agent left in its work folder. Mirrors `Draft` in src-tauri/src/agent/chat.rs. */
export interface ChatDraft {
  size: number;
  /** Larger than Sanctum accepts; it is reported but not offered. */
  tooLarge: boolean;
}

/** How a turn ended. Mirrors `TurnOutcome` in src-tauri/src/agent/chat.rs. */
export interface ChatOutcome {
  status: "completed" | "interrupted" | "failed";
  error: string | null;
  /** How many requests from the agent Sanctum refused during the turn. */
  refused: number;
  draft: ChatDraft | null;
}

/** One step Codex took (the `agent-activity` event). Mirrors `Activity` in src-tauri/src/agent/chat.rs. */
export interface ChatActivity {
  itemId: string;
  kind: "command" | "files" | "thinking" | "tool";
  state: "running" | "done" | "failed" | "declined";
  /** What it did: the command, the files, a short thought. Never command output. */
  label: string;
  durationMs: number | null;
  exitCode: number | null;
  /** How many lines the command printed. */
  outputLines: number | null;
}

/** What a draft is and what it asks for. Mirrors `DraftReport` in src-tauri/src/agent/draft.rs. */
export interface DraftReport {
  name: string;
  description: string;
  size: number;
  /** What the scan found the page asking for. Nothing is granted by it, and a scan can miss things. */
  capabilities: DetectedCapability[];
  /** `version` adds to the tool this session already added. */
  savesAs: "new" | "version";
  toolName: string | null;
}

/** What adding a draft did. Mirrors `Added` in src-tauri/src/agent/draft.rs. */
export interface AddedDraft {
  outcome: "added" | "newVersion" | "unchanged" | "alreadyInLibrary";
  tool: ToolRecord;
  versionNum: number;
}

/** A piece of the agent's reply (the `agent-chat` event). */
export interface ChatText {
  itemId: string;
  text: string;
}

/** A rejected agent command. `code` is stable; `message` is for people. */
export interface AgentCommandError {
  code: string;
  message: string;
}

/** What a signature does and does not mean. Shown wherever a publisher badge appears. */
export const SIGNATURE_MEANING =
  "A signature says who published this file and that it has not been changed. " +
  "It does not mean the tool is safe, and it gives the tool no permissions.";

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

/** What a sanctum://install link asked for, already validated by Rust. */
export interface LinkInstallRequest {
  appId: string;
  /** Canonical base URL ending in "/". */
  registryUrl: string;
  /** True only when it is exactly the Enigma public registry. */
  isEnigma: boolean;
}

/** A link Sanctum received. A refusal carries a fixed message, never text from the link. */
export type LinkEvent =
  | { kind: "install"; request: LinkInstallRequest }
  | { kind: "refused"; message: string; code: string };
