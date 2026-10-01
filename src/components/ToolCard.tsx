// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { type ToolWithVersion, shortSha, formatBytes } from "@/lib/types";
import { Commands } from "@/lib/commands";
import { PermissionBadge } from "./PermissionBadge";
import { PublisherBadge } from "./PublisherBadge";
import { CardMenu } from "./CardMenu";
import { Button } from "@/components/ui/button";
import {
  Play, Eye, AlertTriangle, Trash2,
  Clipboard, FolderOpen, Loader2, Wifi, WifiOff,
} from "lucide-react";

interface ToolCardProps {
  item: ToolWithVersion;
  onRun: (toolId: string) => void;
  onInspect: (toolId: string) => void;
  onDeleted: (toolId: string) => void;
  onUpdated: (toolId: string) => void;
}

type Detected = NonNullable<ToolWithVersion["current_version"]>["manifest"]["detected"];

// Network chip: only when the tool asks for network access. Shows whether it is approved.
function NetworkStatus({ detected, approvals }: { detected: Detected; approvals: ToolWithVersion["tool"]["approvals"] }) {
  if (!detected.some((c) => typeof c === "object" && "net" in c)) return null;
  const on = approvals.some((a) => typeof a === "object" && "net" in a);
  return (
    <span className={"cap-chip " + (on ? "" : "cap-chip-quiet")} style={on ? { color: "#137A4B", borderColor: "rgba(30,158,98,.35)" } : undefined}>
      {on ? <Wifi className="h-3 w-3" aria-hidden="true" /> : <WifiOff className="h-3 w-3" aria-hidden="true" />}
      {on ? "Network on" : "Network off"}
    </span>
  );
}

export function ToolCard({ item, onRun, onInspect, onDeleted, onUpdated }: ToolCardProps) {
  const { tool, current_version: cv, provenance } = item;
  // A stored icon can be unusable (bad data URI). Fall back to the initials tile instead of
  // the browser's broken-image glyph.
  const [iconBroken, setIconBroken] = useState(false);
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
  const cannotRun = isQuarantined || !cv;
  const hasCaps = detected.length > 0;

  return (
    <div className={"tool-card" + (isQuarantined ? " tool-card-quarantined" : "")}>
      <div style={{ padding: "18px 18px 16px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Identity: icon, name + publisher badge, version */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {tool.icon_data && !iconBroken ? (
            <img
              src={tool.icon_data}
              alt=""
              onError={() => setIconBroken(true)}
              style={{ width: 40, height: 40, borderRadius: 9, objectFit: "contain", flexShrink: 0 }}
            />
          ) : (
            <div style={{
              width: 40, height: 40, flexShrink: 0,
              background: "#F7F8FA", border: "1px solid #E3E7EC", borderRadius: 9,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "Poppins, system-ui, sans-serif",
              fontWeight: 700, fontSize: 13, color: "#6B717A", userSelect: "none",
            }} aria-hidden="true">
              {tool.name.slice(0, 2).toUpperCase()}
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
              <h3
                title={tool.name}
                style={{
                  fontFamily: "Poppins, system-ui, sans-serif",
                  fontWeight: 600, fontSize: 15, color: "#0A0A0A",
                  letterSpacing: "-0.01em", lineHeight: 1.3, margin: 0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {tool.name}
              </h3>
              <PublisherBadge provenance={provenance} />
            </div>
            <div style={{
              fontFamily: "'Space Mono', ui-monospace, monospace",
              fontSize: 11, color: "#6B717A", marginTop: 1,
            }}>
              {cv ? `v${cv.version_num}` : "No version"}
            </div>
          </div>
        </div>

        {/* Description */}
        {tool.description && (
          <p style={{
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 13, color: "#565B62", margin: 0, lineHeight: 1.5,
            overflow: "hidden", display: "-webkit-box",
            WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>
            {tool.description}
          </p>
        )}

        {/* Quarantine banner */}
        {isQuarantined && (
          <div role="alert" style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "rgba(210,64,46,.08)", border: "1px solid rgba(210,64,46,.2)",
            borderRadius: 6, padding: "6px 10px",
            fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, color: "#B0301F",
          }}>
            <AlertTriangle style={{ width: 14, height: 14, flexShrink: 0 }} aria-hidden="true" />
            Quarantined: integrity check failed
          </div>
        )}

        {/* Capabilities */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <PermissionBadge detected={detected} mode="compact" />
          {cv && <NetworkStatus detected={detected as Detected} approvals={tool.approvals} />}
        </div>

        {/* Tags */}
        {tool.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {tool.tags.map((tag) => (
              <span key={tag} style={{
                fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, color: "#6B717A",
                border: "1px solid #E3E7EC", borderRadius: 4, padding: "1px 6px",
              }}>{tag}</span>
            ))}
          </div>
        )}

        {/* Meta row: hash and size (Space Mono, data) */}
        {cv && (
          <div style={{
            fontFamily: "'Space Mono', ui-monospace, monospace",
            fontSize: 11, color: "#6B717A",
            display: "flex", alignItems: "center", gap: 6,
            marginTop: hasCaps || tool.tags.length > 0 ? 0 : -2,
          }}>
            <span title={cv.checksum}>{shortSha(cv.checksum)}</span>
            <span style={{ color: "#D0D5DC" }} aria-hidden="true">·</span>
            <span>{formatBytes(cv.file_size)}</span>
          </div>
        )}
      </div>

      {/* Update panel */}
      {showUpdate && (
        <div style={{
          margin: "0 18px 14px",
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
            <Button size="sm" variant="ghost" disabled={updating} onClick={() => { setShowUpdate(false); setUpdateError(null); }}>
              Cancel
            </Button>
          </div>
          {updateError && (
            <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: 11, color: "#B0301F", margin: 0 }}>
              {updateError}
            </p>
          )}
        </div>
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <div role="alertdialog" aria-label={`Delete ${tool.name}`} style={{
          margin: "0 18px 14px",
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
            <Button size="sm" variant="ghost" autoFocus disabled={deleting} onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Actions: Run + Inspect as one joined pair, overflow menu for Update and Delete */}
      <div style={{
        marginTop: "auto", borderTop: "1px solid #EEF1F4",
        padding: "12px 12px 12px 18px",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{ display: "flex" }}>
          <button
            type="button"
            className="card-btn card-btn-primary card-btn-left"
            disabled={cannotRun}
            onClick={() => { closeAllPanels(); onRun(tool.id); }}
          >
            <Play style={{ width: 13, height: 13 }} aria-hidden="true" />
            Run
          </button>
          <button
            type="button"
            className="card-btn card-btn-right"
            onClick={() => { closeAllPanels(); onInspect(tool.id); }}
          >
            <Eye style={{ width: 14, height: 14 }} aria-hidden="true" />
            Inspect
          </button>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <CardMenu
            toolName={tool.name}
            onUpdate={() => { setConfirmDelete(false); setUpdateError(null); setShowUpdate(true); }}
            onDelete={() => { setShowUpdate(false); setConfirmDelete(true); }}
          />
        </div>
      </div>
    </div>
  );
}
