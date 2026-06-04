// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { type ToolWithVersion, shortSha, formatBytes } from "@/lib/types";
import { Commands } from "@/lib/commands";
import { PermissionBadge } from "./PermissionBadge";
import { Button } from "@/components/ui/button";
import {
  Play, Eye, AlertTriangle, Trash2, RefreshCw,
  Clipboard, FolderOpen, X, Loader2, Wifi, WifiOff,
} from "lucide-react";

interface ToolCardProps {
  item: ToolWithVersion;
  onRun: (toolId: string) => void;
  onInspect: (toolId: string) => void;
  onDeleted: (toolId: string) => void;
  onUpdated: (toolId: string) => void;
}

// ── Network status pill ────────────────────────────────────────────────────
function NetworkStatus({
  detected,
  approvals,
}: {
  detected: NonNullable<ToolWithVersion["current_version"]>["manifest"]["detected"];
  approvals: ToolWithVersion["tool"]["approvals"];
}) {
  const hasNet = detected.some((c) => typeof c === "object" && "net" in c);
  if (!hasNet) return null;

  const on = approvals.some((a) => typeof a === "object" && "net" in a);

  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: "4px",
        background: on ? "rgba(30,158,98,.10)" : "#F7F8FA",
        color: on ? "#137A4B" : "#8A9099",
        border: on ? "none" : "1px solid #E3E7EC",
        fontFamily: "Inter, system-ui, sans-serif",
        fontWeight: 500, fontSize: "11px",
        padding: "2px 8px", borderRadius: "9999px",
        whiteSpace: "nowrap",
      }}
    >
      {on ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
      {on ? "Network on" : "Network off"}
    </span>
  );
}

export function ToolCard({ item, onRun, onInspect, onDeleted, onUpdated }: ToolCardProps) {
  const { tool, current_version: cv } = item;
  const isQuarantined = cv?.quarantined === true;
  const detected = cv?.manifest.detected ?? [];

  // ── Delete ───────────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await Commands.deleteTool(tool.id);
      onDeleted(tool.id);
    } catch (e) {
      console.error("delete failed:", e);
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [tool.id, onDeleted]);

  // ── Update ───────────────────────────────────────────────────────────────
  const [showUpdate, setShowUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const handleUpdateClipboard = useCallback(async () => {
    setUpdating(true); setUpdateError(null);
    try {
      await Commands.updateToolFromClipboard(tool.id);
      onUpdated(tool.id);
      setShowUpdate(false);
    } catch (e) {
      setUpdateError(String(e));
    } finally { setUpdating(false); }
  }, [tool.id, onUpdated]);

  const handleUpdateFile = useCallback(async () => {
    const selected = await open({
      title: "Select updated HTML",
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
      multiple: false,
    });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    setUpdating(true); setUpdateError(null);
    try {
      await Commands.updateToolFromPath(tool.id, path);
      onUpdated(tool.id);
      setShowUpdate(false);
    } catch (e) {
      setUpdateError(String(e));
    } finally { setUpdating(false); }
  }, [tool.id, onUpdated]);

  const closeAllPanels = () => { setShowUpdate(false); setConfirmDelete(false); };

  return (
    <div
      style={{
        background: "#FFFFFF",
        border: isQuarantined ? "1px solid rgba(210,64,46,.35)" : "1px solid #E3E7EC",
        borderRadius: "10px",
        boxShadow: "0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)",
        display: "flex",
        flexDirection: "column",
        transition: "box-shadow 0.15s, border-color 0.15s",
        overflow: "hidden",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 4px 8px rgba(16,24,40,.08), 0 2px 4px rgba(16,24,40,.06)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow =
          "0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.04)";
      }}
    >
      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>

        {/* Header: avatar + name/description */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
          {tool.icon_data ? (
            <img src={tool.icon_data} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: "contain", flexShrink: 0 }} />
          ) : (
            <div style={{
              width: 36, height: 36, flexShrink: 0,
              background: "#F7F8FA", border: "1px solid #E3E7EC", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "Poppins, system-ui, sans-serif",
              fontWeight: 700, fontSize: 13, color: "#8A9099", userSelect: "none",
            }}>
              {tool.name.slice(0, 2).toUpperCase()}
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{
              fontFamily: "Poppins, system-ui, sans-serif",
              fontWeight: 700, fontSize: 14, color: "#0A0A0A",
              letterSpacing: "-0.01em", lineHeight: 1.3, margin: 0,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {tool.name}
            </h3>
            {tool.description && (
              <p style={{
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12, color: "#565B62",
                margin: "2px 0 0", lineHeight: 1.45,
                overflow: "hidden", display: "-webkit-box",
                WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
              }}>
                {tool.description}
              </p>
            )}
          </div>
        </div>

        {/* Quarantine banner */}
        {isQuarantined && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "rgba(210,64,46,.08)", border: "1px solid rgba(210,64,46,.2)",
            borderRadius: 6, padding: "6px 10px",
            fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, color: "#B0301F",
          }}>
            <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} />
            Quarantined — integrity check failed
          </div>
        )}

        {/* Capabilities: permission badges on one line, network pill below */}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <PermissionBadge detected={detected} mode="compact" />
          {cv && (
            <NetworkStatus
              detected={detected as NonNullable<ToolWithVersion["current_version"]>["manifest"]["detected"]}
              approvals={tool.approvals}
            />
          )}
        </div>

        {/* Tags */}
        {tool.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tool.tags.map((tag) => (
              <span key={tag} style={{
                fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, color: "#565B62",
                background: "#F7F8FA", border: "1px solid #E3E7EC",
                borderRadius: 4, padding: "2px 7px",
              }}>{tag}</span>
            ))}
          </div>
        )}

        {/* Metadata (Space Mono — data) */}
        <div style={{
          fontFamily: "'Space Mono', ui-monospace, monospace",
          fontSize: 11, color: "#8A9099",
          display: "flex", alignItems: "center", gap: 6,
        }}>
          {cv ? (
            <>
              <span>{shortSha(cv.checksum)}</span>
              <span style={{ color: "#D0D5DC" }}>·</span>
              <span>{formatBytes(cv.file_size)}</span>
              <span style={{ color: "#D0D5DC" }}>·</span>
              <span>v{cv.version_num}</span>
            </>
          ) : (
            <span style={{ fontStyle: "italic", fontFamily: "Inter, system-ui, sans-serif" }}>No version</span>
          )}
        </div>
      </div>

      {/* ── Expandable: Update panel ─────────────────────────────────────── */}
      {showUpdate && (
        <div style={{
          margin: "0 16px 12px",
          background: "#F7F8FA", border: "1px solid #E3E7EC",
          borderRadius: 8, padding: "10px 12px",
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          <span style={{ fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, fontSize: 12, color: "#565B62" }}>
            Add new version from:
          </span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={updating} onClick={handleUpdateClipboard}>
              {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Clipboard className="h-3 w-3" />}
              Paste Clipboard
            </Button>
            <Button size="sm" variant="ghost" className="gap-1.5" disabled={updating} onClick={handleUpdateFile}>
              <FolderOpen className="h-3 w-3" /> Open File…
            </Button>
          </div>
          {updateError && (
            <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, color: "#B0301F", margin: 0 }}>
              {updateError}
            </p>
          )}
        </div>
      )}

      {/* ── Expandable: Delete confirm ───────────────────────────────────── */}
      {confirmDelete && (
        <div style={{
          margin: "0 16px 12px",
          background: "rgba(210,64,46,.06)", border: "1px solid rgba(210,64,46,.2)",
          borderRadius: 8, padding: "10px 12px",
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, color: "#B0301F", margin: 0 }}>
            Delete <strong>{tool.name}</strong> and all versions? Cannot be undone.
          </p>
          <div style={{ display: "flex", gap: 6 }}>
            <Button size="sm" variant="destructive" className="gap-1.5" disabled={deleting} onClick={handleDelete}>
              {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Delete
            </Button>
            <Button size="sm" variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div style={{ borderTop: "1px solid #E3E7EC" }}>

        {/* Primary row: Inspect + Run — equal halves */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
          <button
            onClick={() => { closeAllPanels(); onInspect(tool.id); }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "10px 0",
              background: "none", border: "none", borderRight: "1px solid #E3E7EC",
              cursor: "pointer",
              fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600,
              fontSize: 13, color: "#565B62",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "#F7F8FA"; (e.currentTarget as HTMLButtonElement).style.color = "#0A0A0A"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; (e.currentTarget as HTMLButtonElement).style.color = "#565B62"; }}
          >
            <Eye style={{ width: 14, height: 14 }} />
            Inspect
          </button>

          <button
            onClick={() => { closeAllPanels(); onRun(tool.id); }}
            disabled={isQuarantined || !cv}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "10px 0",
              background: "none", border: "none",
              cursor: isQuarantined || !cv ? "not-allowed" : "pointer",
              opacity: isQuarantined || !cv ? 0.4 : 1,
              fontFamily: "Inter, system-ui, sans-serif", fontWeight: 700,
              fontSize: 13, color: "#0A0A0A",
              transition: "background 0.12s",
            }}
            onMouseEnter={(e) => {
              if (!isQuarantined && cv)
                (e.currentTarget as HTMLButtonElement).style.background = "#F7F8FA";
            }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >
            <Play style={{ width: 14, height: 14 }} />
            Run
          </button>
        </div>

        {/* Secondary row: Update (left) + Delete icon (right) */}
        <div style={{
          display: "flex", alignItems: "center",
          borderTop: "1px solid #E3E7EC",
          padding: "0 4px",
        }}>
          <button
            onClick={() => { setConfirmDelete(false); setShowUpdate((v) => !v); setUpdateError(null); }}
            style={{
              display: "flex", alignItems: "center", gap: 5, flex: 1,
              padding: "7px 8px",
              background: "none", border: "none", cursor: "pointer",
              fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500,
              fontSize: 12, color: showUpdate ? "#0A0A0A" : "#8A9099",
              borderRadius: 6,
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#0A0A0A"; (e.currentTarget as HTMLButtonElement).style.background = "#F7F8FA"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = showUpdate ? "#0A0A0A" : "#8A9099"; (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >
            <RefreshCw style={{ width: 13, height: 13 }} />
            Update
          </button>

          <button
            onClick={() => { setShowUpdate(false); setConfirmDelete((v) => !v); }}
            title="Delete tool"
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 30, height: 30,
              background: "none", border: "none", cursor: "pointer",
              borderRadius: 6,
              color: confirmDelete ? "#B0301F" : "#C4C9D1",
              transition: "color 0.12s, background 0.12s",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#B0301F"; (e.currentTarget as HTMLButtonElement).style.background = "rgba(210,64,46,.06)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = confirmDelete ? "#B0301F" : "#C4C9D1"; (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
          >
            {confirmDelete ? <X style={{ width: 14, height: 14 }} /> : <Trash2 style={{ width: 14, height: 14 }} />}
          </button>
        </div>
      </div>
    </div>
  );
}
