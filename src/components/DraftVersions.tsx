// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { ExternalLink, Loader2, Undo2 } from "lucide-react";
import { formatBytes, type DraftVersion } from "@/lib/types";
import { Button } from "@/components/ui/button";

const font = "'Inter', system-ui, sans-serif";

/** "Draft 3", or what the first one is when it came from the library. */
export function versionLabel(v: DraftVersion): string {
  return v.loaded ? "Starting point" : `Draft ${v.number}`;
}

function clock(at: number): string {
  try {
    return new Date(at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * Every draft of this conversation, newest first. Any of them can be previewed, and any can be
 * put back as the current one, after which Codex carries on from it. Going back loses nothing:
 * the draft you leave stays in the list. This is separate from your library's own versions.
 */
export function DraftVersions({
  versions,
  busy,
  restoring,
  onPreview,
  onRestore,
}: {
  versions: DraftVersion[];
  /** Codex is working, so a draft cannot be put back now. */
  busy: boolean;
  restoring: boolean;
  onPreview: (sha: string) => void;
  onRestore: (v: DraftVersion) => void;
}) {
  if (versions.length < 2) return null;
  return (
    <details open data-testid="draft-versions" style={{ fontFamily: font, fontSize: 13 }}>
      <summary style={{ cursor: "pointer", color: "var(--app-ink-2)" }}>{`Drafts in this conversation (${versions.length})`}</summary>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {versions.map((v) => (
          <li key={v.sha} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <strong>{versionLabel(v)}</strong>
              <span style={{ color: "var(--app-ink-2)" }}>{`, ${formatBytes(v.size)}${clock(v.at) ? `, ${clock(v.at)}` : ""}`}</span>
              {v.current && <span style={{ marginLeft: 8, fontSize: 11.5, border: "1px solid var(--app-border-2)", borderRadius: 4, padding: "1px 6px" }}>Current</span>}
            </span>
            <span style={{ display: "inline-flex", gap: 6 }}>
              <Button variant="ghost" size="sm" aria-label={`Preview ${versionLabel(v)}`} onClick={() => onPreview(v.sha)}>
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Preview
              </Button>
              {!v.current && (
                <Button variant="outline" size="sm" aria-label={`Go back to ${versionLabel(v)}`} disabled={busy || restoring} onClick={() => onRestore(v)}>
                  {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />}
                  Go back to this
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
