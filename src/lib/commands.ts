// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { invoke } from "@tauri-apps/api/core";
import { cleanAccount, cleanAdded, cleanCatalogue, cleanCheckReport, cleanNotices, cleanOutcome, cleanReport, cleanStarted, cleanVersions, cleanDetail, cleanRegistry } from "@/lib/text";
import type {
  AgentAccount,
  AddedDraft,
  AgentSetup,
  ChatDraft,
  ChatOutcome,
  ChatStarted,
  DetectedCapability,
  DraftReport,
  DraftVersion,
  BundleInstall,
  IngestResult,
  MetadataUpdate,
  ToolManifest,
  ToolWithVersion,
  UpdateInfo,
  PolicyStatus,
  TrustAnchorInfo,
  LinkEvent,
  RegistryAppDetail,
  RegistryBatchItem,
  RegistryCatalogue,
  RegistryCheckReport,
  RegistryNotices,
  RegistryInstallOutcome,
  RegistryRefreshReport,
  RegistrySummary,
  ProvenanceRecord,
  VersionRecord,
} from "./types";

// All invoke calls are typed. The generic parameter matches the Rust return type.

export const Commands = {
  /** A sanctum:// link that arrived before the window was listening. Taking it clears it. */
  takePendingLink(): Promise<LinkEvent | null> {
    return invoke("take_pending_link");
  },

  /** Whether the agent can be set up here and whether Codex is already downloaded. Looks at files only. */
  agentSetup(): Promise<AgentSetup> {
    return invoke("agent_setup");
  },

  /** Turns building apps on or off. Off is the default; off also stops Codex and ends any session. */
  agentSetEnabled(on: boolean): Promise<AgentSetup> {
    return invoke("agent_set_enabled", { on });
  },

  /** The signed-in account. Starts the local Codex process if needed; downloads nothing. */
  agentAccount(): Promise<AgentAccount> {
    return invoke<AgentAccount>("agent_account").then(cleanAccount);
  },

  /**
   * Sign in with ChatGPT. The first time it downloads Codex (progress arrives as `agent-download`
   * events), then opens the browser and waits until the person finishes there. Resolves at once if
   * already signed in. Rejects with an AgentCommandError.
   */
  agentSignIn(): Promise<AgentAccount> {
    return invoke<AgentAccount>("agent_sign_in").then(cleanAccount);
  },

  /** Stops a download, or a sign-in that is waiting for the browser. */
  agentCancelSignIn(): Promise<void> {
    return invoke("agent_cancel_sign_in");
  },

  agentSignOut(): Promise<AgentAccount> {
    return invoke<AgentAccount>("agent_sign_out").then(cleanAccount);
  },

  /**
   * Opens the Create window, or brings it forward. It is a window of its own so a session
   * survives while you use the rest of Sanctum. With `toolId`, the conversation is about changing
   * that app from the library. Rejects with an AgentCommandError.
   */
  agentOpenCreateWindow(toolId?: string): Promise<void> {
    return invoke("agent_open_create_window", { toolId: toolId ?? null });
  },

  /**
   * Opens a build session: a new private work folder and a Codex thread that may write only
   * there. Needs a ChatGPT sign-in (`not_signed_in` otherwise). No request leaves the computer
   * until the first message.
   */
  agentChatStart(source?: string | null): Promise<ChatStarted> {
    return invoke<ChatStarted>("agent_chat_start", { source: source ?? null }).then(cleanStarted);
  },

  /** The drafts this conversation has produced, newest first. */
  agentDraftHistory(): Promise<DraftVersion[]> {
    return invoke<DraftVersion[]>("agent_draft_history").then(cleanVersions);
  },

  /** Puts an earlier draft back as the current one. Codex is told on the next message. */
  agentRestoreDraft(sha: string): Promise<ChatDraft> {
    return invoke<ChatDraft>("agent_restore_draft", { sha });
  },

  /** The person's standing instructions for every app (empty when none). */
  agentGetInstructions(): Promise<string> {
    return invoke<string>("agent_get_instructions");
  },

  /** Saves the standing instructions. They apply to conversations started after this. */
  agentSetInstructions(text: string): Promise<string> {
    return invoke<string>("agent_set_instructions", { text });
  },

  /**
   * Sends a message and resolves when Codex has finished. The reply streams meanwhile as
   * `agent-chat` events.
   */
  agentChatSend(text: string): Promise<ChatOutcome> {
    return invoke<ChatOutcome>("agent_chat_send", { text }).then(cleanOutcome);
  },

  /** What the open session's draft is and what it asks for, from the scan. Grants nothing. */
  agentScanDraft(): Promise<DraftReport> {
    return invoke<DraftReport>("agent_scan_draft").then(cleanReport);
  },

  /**
   * Adds the draft to the library with no approvals, marked as made by an agent. A later draft
   * from the same session becomes a new version of that tool. Rejects with an AgentCommandError.
   */
  agentAddDraft(): Promise<AddedDraft> {
    return invoke<AddedDraft>("agent_add_draft").then(cleanAdded);
  },

  /**
   * Opens the open session's draft (app.html) in a window of its own, as a copy Sanctum made.
   * The page runs with nothing approved: no network, no devices, no access to Sanctum. Nothing
   * is added to the library. Rejects with an AgentCommandError.
   */
  agentPreviewDraft(sha?: string): Promise<void> {
    return invoke("agent_preview_draft", { sha: sha ?? null });
  },

  /** Stops the running turn. */
  agentChatStop(): Promise<void> {
    return invoke("agent_chat_stop");
  },

  /** Ends the session and deletes its work folder. */
  agentChatClose(): Promise<void> {
    return invoke("agent_chat_close");
  },

  /** Ingest raw HTML string into the library. */
  ingestHtml(html: string, sourceFilename?: string): Promise<IngestResult> {
    return invoke("ingest_html", { html, sourceFilename: sourceFilename ?? null });
  },

  /** Read the OS clipboard and ingest its content as a tool. */
  ingestFromClipboard(): Promise<IngestResult> {
    return invoke("ingest_from_clipboard");
  },

  /** Ingest an HTML tool from a filesystem path (Rust reads the file). */
  ingestFromPath(path: string): Promise<IngestResult> {
    return invoke("ingest_from_path", { path });
  },

  /** Install a signed .sanctum bundle. Rust verifies it; the tool still starts with no approvals. */
  ingestBundleFromPath(path: string): Promise<BundleInstall> {
    return invoke("ingest_bundle_from_path", { path });
  },

  /** Publisher keys this build recognises (read-only). */
  getTrustAnchors(): Promise<TrustAnchorInfo[]> {
    return invoke("get_trust_anchors");
  },

  /** Registries the user added. No network: reads the cached, re-verified catalogue. */
  listRegistries(): Promise<RegistrySummary[]> {
    return invoke<RegistrySummary[]>("list_registries").then((rs) => rs.map(cleanRegistry));
  },

  /**
   * Add a registry by address. Contacts that address once. Rejects with a
   * RegistryCommandError; for code "untrusted_signer", show the signer key and, only if the
   * user agrees, call again with it as `pinnedKey`.
   */
  addRegistry(url: string, pinnedKey?: string): Promise<RegistrySummary> {
    return invoke("add_registry", { url, pinnedKey: pinnedKey ?? null });
  },

  /** Fetch the registry again. A failed refresh leaves the cached catalogue unchanged. */
  refreshRegistry(id: string): Promise<RegistryRefreshReport> {
    return invoke("refresh_registry", { id });
  },

  /**
   * Fetch every registry again, then say which installed tools have an update or were
   * withdrawn. Contacts each registry. Runs when the user clicks, or from the optional timer.
   */
  checkRegistries(): Promise<RegistryCheckReport> {
    return invoke<RegistryCheckReport>("check_registries").then(cleanCheckReport);
  },

  /** Updates and withdrawn tools for the library, from the cache. No network. */
  registryNotices(): Promise<RegistryNotices> {
    return invoke<RegistryNotices>("registry_notices").then(cleanNotices);
  },

  /** The cached, re-verified catalogue with install state per app. No network. */
  registryCatalogue(registryId: string): Promise<RegistryCatalogue> {
    return invoke<RegistryCatalogue>("registry_catalogue", { registryId }).then(cleanCatalogue);
  },

  /** An app's changelog, manual, screenshots and icon. Contacts the registry; all verified. */
  registryAppDetail(registryId: string, appId: string): Promise<RegistryAppDetail> {
    return invoke<RegistryAppDetail>("registry_app_detail", { registryId, appId }).then(cleanDetail);
  },

  /**
   * Install one app from a registry (default: its listed latest). The tool starts with
   * nothing approved. Rejects with a RegistryCommandError, e.g. code "revoked",
   * "inconsistent" or "not_installable".
   */
  installFromRegistry(
    registryId: string,
    appId: string,
    version?: string,
  ): Promise<RegistryInstallOutcome> {
    return invoke("install_from_registry", { registryId, appId, version: version ?? null });
  },

  /** Install several apps, or every installable one when `appIds` is omitted. Approves nothing. */
  installAllFromRegistry(registryId: string, appIds?: string[]): Promise<RegistryBatchItem[]> {
    return invoke("install_all_from_registry", { registryId, appIds: appIds ?? null });
  },

  /** Forget a registry and its cache. Tools already installed from it are not touched. */
  removeRegistry(id: string): Promise<void> {
    return invoke("remove_registry", { id });
  },

  /** Whether an organisation policy manages this install, and whether it applied. */
  getPolicyStatus(): Promise<PolicyStatus> {
    return invoke("get_policy_status");
  },

  /** Provenance for a version, or null when it was not installed from a signed bundle. */
  getProvenance(versionId: string): Promise<ProvenanceRecord | null> {
    return invoke("get_provenance", { versionId });
  },

  /** Permanently delete a tool and all its versions. Irreversible. */
  deleteTool(toolId: string): Promise<void> {
    return invoke("delete_tool", { toolId });
  },

  /** Add a new version to an existing tool from the OS clipboard. */
  updateToolFromClipboard(toolId: string): Promise<VersionRecord> {
    return invoke("update_tool_from_clipboard", { toolId });
  },

  /** Add a new version to an existing tool from a file path. */
  updateToolFromPath(toolId: string, path: string): Promise<VersionRecord> {
    return invoke("update_tool_from_path", { toolId, path });
  },

  /** List all tools with their current version. */
  listTools(): Promise<ToolWithVersion[]> {
    return invoke("list_tools");
  },

  /** Get a single tool with all versions. */
  getTool(toolId: string): Promise<ToolWithVersion> {
    return invoke("get_tool", { toolId });
  },

  /** Update editable metadata (name, description, tags). */
  updateMetadata(toolId: string, update: MetadataUpdate) {
    return invoke("update_metadata", { toolId, update });
  },

  /** Add a new HTML version to an existing tool. */
  createVersion(toolId: string, html: string): Promise<VersionRecord> {
    return invoke("create_version", { toolId, html });
  },

  /** Compute the SHA-256 checksum of an HTML string. */
  computeChecksum(html: string): Promise<string> {
    return invoke("compute_checksum", { html });
  },

  /** Roll back to a specific version. */
  rollbackVersion(toolId: string, versionId: string): Promise<void> {
    return invoke("rollback_version", { toolId, versionId });
  },

  /** Statically scan HTML and return detected capabilities. */
  scanCapabilities(html: string): Promise<DetectedCapability[]> {
    return invoke("scan_capabilities", { html });
  },

  /** Map a manifest to granted capabilities (v0: always []). */
  capabilitiesForManifest(manifest: ToolManifest): Promise<string[]> {
    return invoke("capabilities_for_manifest", { manifest });
  },

  /**
   * Persist user-approved capabilities for a tool.
   * Pass the full desired approved set — replaces previous approvals entirely.
   * Takes effect on next openToolWindow call; existing open windows are unaffected.
   */
  updateApprovals(toolId: string, approved: DetectedCapability[]): Promise<import("./types").ToolRecord> {
    return invoke("update_approvals", { toolId, approved });
  },

  /** Open a tool in its isolated runtime window. */
  openToolWindow(toolId: string): Promise<void> {
    return invoke("open_tool_window", { toolId });
  },

  /**
   * Check the release endpoint for a newer signed build.
   * Resolves to null when already current; rejects on network failure.
   */
  checkForUpdate(): Promise<UpdateInfo | null> {
    return invoke("check_for_update");
  },

  /**
   * Download, verify, and install the pending update, then relaunch.
   * The app is replaced by the new build — this call does not return normally.
   */
  installUpdate(): Promise<void> {
    return invoke("install_update");
  },
} as const;
