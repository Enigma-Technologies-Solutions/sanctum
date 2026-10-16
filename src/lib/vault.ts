// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import type { ToolWithVersion } from "./types";

export interface VaultGroup {
  /** Stable key for React and tests. */
  key: string;
  title: string;
  kind: "verified" | "unknown" | "unsigned";
  tools: ToolWithVersion[];
}

export const UNSIGNED_TITLE = "Your tools";
export const UNKNOWN_TITLE = "Unknown publisher";

/**
 * Group the library by who published each tool. Recognised publishers come first (by name),
 * then signers Sanctum does not recognise (by key), then tools with no signature at all.
 * Grouping is display only: it grants nothing, and a name comes from a trusted key, never
 * from the tool's own file.
 */
export function groupByPublisher(tools: ToolWithVersion[]): VaultGroup[] {
  const groups = new Map<string, VaultGroup>();
  for (const item of tools) {
    const p = item.provenance;
    let key: string, title: string, kind: VaultGroup["kind"];
    if (!p) {
      key = "unsigned"; title = UNSIGNED_TITLE; kind = "unsigned";
    } else if (p.trust === "verified") {
      key = `verified:${p.publisherKey}`; title = p.publisherName ?? p.publisherKey.slice(0, 16) + "…"; kind = "verified";
    } else {
      key = `unknown:${p.publisherKey}`; title = `${UNKNOWN_TITLE} (${p.publisherKey.slice(0, 16)}…)`; kind = "unknown";
    }
    const g = groups.get(key) ?? { key, title, kind, tools: [] };
    g.tools.push(item);
    groups.set(key, g);
  }
  const rank = { verified: 0, unknown: 1, unsigned: 2 } as const;
  return [...groups.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || a.title.localeCompare(b.title));
}
