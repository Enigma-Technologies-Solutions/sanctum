// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { invoke } from "@tauri-apps/api/core";
import type {
  DetectedCapability,
  IngestResult,
  MetadataUpdate,
  ToolManifest,
  ToolWithVersion,
  VersionRecord,
} from "./types";

// All invoke calls are typed. The generic parameter matches the Rust return type.

export const Commands = {
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
} as const;
