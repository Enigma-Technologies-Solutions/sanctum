// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { ArrowUpCircle, ShieldAlert } from "lucide-react";
import type { RegistryNotices, RegistryRevokedNotice } from "@/lib/types";

const font = "'Inter', system-ui, sans-serif";

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "8px 20px",
  background: "var(--app-surface)",
  color: "var(--app-ink)",
  borderBottom: "1px solid var(--app-border)",
  fontFamily: font,
  fontSize: "13px",
} as const;

/** One sentence for a withdrawn tool. The reason is the registry's own words, shown as text. */
export function revokedLine(n: RegistryRevokedNotice): string {
  const what = `${n.name} ${n.version}`;
  const why = n.reason ? ` (${n.reason})` : "";
  return n.action === "block"
    ? `${n.registryName} withdrew ${what}${why}. It will not open until you install a good version or remove it.`
    : `${n.registryName} withdrew ${what}${why}. It still opens, because you pinned this registry yourself. Decide whether to keep using it.`;
}

/**
 * What the registries say about tools you already have: a withdrawn version, or a newer one.
 * It shows only what is in the saved lists, and it never installs or approves anything.
 */
export function RegistryNoticeBanner({
  notices,
  onOpenCatalogue,
}: {
  notices: RegistryNotices;
  onOpenCatalogue: () => void;
}) {
  const { revoked, updates } = notices;
  if (revoked.length === 0 && updates.length === 0) return null;
  return (
    <div role="region" aria-label="Notices from your registries" data-testid="registry-notices">
      {revoked.map((n) => (
        <div key={n.toolId} role="alert" style={rowStyle}>
          <ShieldAlert
            size={15}
            aria-hidden="true"
            style={{ flexShrink: 0, color: n.action === "block" ? "var(--danger-ink)" : "var(--app-ink-2)" }}
          />
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{revokedLine(n)}</span>
        </div>
      ))}
      {updates.length > 0 && (
        <div role="status" style={rowStyle}>
          <ArrowUpCircle size={15} aria-hidden="true" style={{ flexShrink: 0, color: "var(--app-ink-2)" }} />
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            {updates.length === 1 ? "A newer version is listed for " : `Newer versions are listed for ${updates.length} tools: `}
            {updates.map((u) => `${u.name} ${u.latest}`).join(", ")}.
          </span>
          <button
            type="button"
            onClick={onOpenCatalogue}
            style={{
              flexShrink: 0,
              padding: "5px 12px",
              background: "var(--app-bg)",
              color: "var(--app-ink)",
              border: "1px solid var(--app-border)",
              borderRadius: "6px",
              fontFamily: font,
              fontSize: "12px",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Open Catalogue
          </button>
        </div>
      )}
    </div>
  );
}
