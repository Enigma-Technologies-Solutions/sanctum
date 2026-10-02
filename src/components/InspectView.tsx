// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  ToolWithVersion,
  VersionRecord,
  DetectedCapability,
  ProvenanceRecord,
} from "@/lib/types";
import { formatBytes, formatDate, capabilityToPlain, SIGNATURE_MEANING } from "@/lib/types";
import { Commands } from "@/lib/commands";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertTriangle, ArrowLeft, Check, Clock,
  Loader2, Play, RotateCcw, Tag, X, Shield, Info,
  Trash2, RefreshCw, Clipboard, FolderOpen,
  Camera, Mic, MapPin, Bell, Usb, Cable, Mouse, Bluetooth, HardDrive, Globe,
  CreditCard, Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Capability approval helpers ────────────────────────────────────────────

/** What the "Signed" row says. Never "safe": a signature names a publisher and nothing else. */
function provenanceLabel(p: ProvenanceRecord | null): string {
  if (!p) return "Unsigned";
  if (p.trust === "verified") return `Verified publisher: ${p.publisherName ?? p.publisherKey}`;
  return `Signed by an unknown publisher (${p.publisherKey.slice(0, 16)}…)`;
}

function capKey(cap: DetectedCapability): string {
  if (typeof cap === "string") return cap;
  return "smartcard" in cap ? "smartcard" : "net";
}

function isApproved(cap: DetectedCapability, approvals: DetectedCapability[]): boolean {
  const k = capKey(cap);
  return approvals.some((a) => capKey(a) === k);
}

function toggleCap(
  cap: DetectedCapability,
  approvals: DetectedCapability[],
): DetectedCapability[] {
  return isApproved(cap, approvals)
    ? approvals.filter((a) => capKey(a) !== capKey(cap))
    : [...approvals, cap];
}

// ── Cap row icons ──────────────────────────────────────────────────────────
const CAP_ICON: Record<string, LucideIcon> = {
  camera: Camera, microphone: Mic, geolocation: MapPin,
  notifications: Bell, usb: Usb, serial: Cable,
  hid: Mouse, bluetooth: Bluetooth, storage: HardDrive, net: Globe,
  smartcard: CreditCard,
};

// ── Approval risk warnings ─────────────────────────────────────────────────
function capRiskNote(cap: DetectedCapability): string {
  if (typeof cap === "string") {
    if (cap === "camera" || cap === "microphone")
      return "Grants hardware access. The tool can capture audio/video while its window is open.";
    if (cap === "geolocation")
      return "Reveals your physical location to the tool.";
    if (cap === "storage")
      return "Tool can persist data locally. Cleared when you remove the tool.";
    return "";
  }
  if ("smartcard" in cap) {
    if (cap.smartcard.length === 1 && cap.smartcard[0] === "(dynamic)")
      return "This tool picks its applet at run time, so Sanctum cannot tell you which one. Approving only lets it list readers. Every applet selection will still be refused.";
    return "Grants direct APDU access to the listed applets on any card you insert. Sanctum blocks re-selection, so the tool cannot reach other applets on the same card.";
  }
  return "Allows the tool to make network requests to the listed domains.";
}

// Section label — Inter, muted, small caps feel
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: "11px", fontWeight: 600,
        color: "#8A9099", textTransform: "uppercase",
        letterSpacing: "0.08em", marginBottom: "8px",
      }}
    >
      {children}
    </div>
  );
}

interface InspectViewProps {
  item: ToolWithVersion;
  onBack: () => void;
  onRun: (toolId: string) => void;
  onRefresh: () => void;
  onDelete?: (toolId: string) => void;
}

export function InspectView({ item, onBack, onRun, onRefresh, onDelete }: InspectViewProps) {
  const { tool, current_version: cv, all_versions, provenance } = item;
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(tool.name);
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState(tool.description);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState(tool.tags);
  const [approvals, setApprovals] = useState<DetectedCapability[]>(tool.approvals ?? []);
  const [saving, setSaving] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Publisher version per installed version, for versions that came from a signed bundle.
  const [publisherVersions, setPublisherVersions] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    Promise.all(
      all_versions.map(async (v) => {
        const p = await Commands.getProvenance(v.id).catch(() => null);
        return [v.id, p?.version] as const;
      }),
    ).then((pairs) => {
      if (!live) return;
      const next: Record<string, string> = {};
      for (const [id, ver] of pairs) if (ver) next[id] = ver;
      setPublisherVersions(next);
    });
    return () => { live = false; };
  }, [all_versions]);
  const versionLabel = (v: { id: string; version_num: number }) =>
    publisherVersions[v.id] ? `v${publisherVersions[v.id]}` : `v${v.version_num}`;

  // Sync approvals if parent refreshes the tool record
  useEffect(() => {
    setApprovals(tool.approvals ?? []);
  }, [tool.approvals]);

  const handleToggle = useCallback(
    async (cap: DetectedCapability) => {
      const next = toggleCap(cap, approvals);
      setApprovals(next);
      setApprovalSaving(true);
      try {
        await Commands.updateApprovals(tool.id, next);
        onRefresh();
      } finally {
        setApprovalSaving(false);
      }
    },
    [approvals, tool.id, onRefresh]
  );

  const handleUpdateClipboard = useCallback(async () => {
    setUpdating(true); setUpdateError(null);
    try {
      await Commands.updateToolFromClipboard(tool.id);
      setShowUpdate(false); onRefresh();
    } catch (e) { setUpdateError(String(e)); }
    finally { setUpdating(false); }
  }, [tool.id, onRefresh]);

  const handleUpdateFile = useCallback(async () => {
    const selected = await open({ title: "Select updated HTML or signed bundle", filters: [{ name: "HTML or signed bundle", extensions: ["html", "htm", "sanctum"] }], multiple: false });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    setUpdating(true); setUpdateError(null);
    try {
      const result = path.endsWith(".sanctum")
        ? await Commands.ingestBundleFromPath(path)
        : null;
      if (result) {
        if (result.tool.id !== tool.id) {
          throw new Error("This bundle is for a different app, so it was added as its own tool, not as an update.");
        }
      } else {
        await Commands.updateToolFromPath(tool.id, path);
      }
      setShowUpdate(false); onRefresh();
    } catch (e) { setUpdateError(String(e)); }
    finally { setUpdating(false); }
  }, [tool.id, onRefresh]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await Commands.deleteTool(tool.id);
      onDelete?.(tool.id);
      onBack();
    } catch (e) { console.error(e); setDeleting(false); }
  }, [tool.id, onDelete, onBack]);

  const saveField = useCallback(
    async (field: "name" | "description" | "tags") => {
      setSaving(true);
      try {
        await Commands.updateMetadata(tool.id, {
          ...(field === "name" && { name }),
          ...(field === "description" && { description }),
          ...(field === "tags" && { tags }),
        });
        if (field === "name") setEditingName(false);
        if (field === "description") setEditingDesc(false);
        onRefresh();
      } finally {
        setSaving(false);
      }
    },
    [tool.id, name, description, tags, onRefresh]
  );

  const rollback = useCallback(async (v: VersionRecord) => {
    setRolling(true);
    try { await Commands.rollbackVersion(tool.id, v.id); onRefresh(); }
    finally { setRolling(false); }
  }, [tool.id, onRefresh]);

  const addTag = useCallback(() => {
    const t = tagInput.trim().toLowerCase();
    if (t && !tags.includes(t)) {
      const next = [...tags, t];
      setTags(next);
      setTagInput("");
      Commands.updateMetadata(tool.id, { tags: next }).then(onRefresh);
    }
  }, [tagInput, tags, tool.id, onRefresh]);

  const removeTag = useCallback((tag: string) => {
    const next = tags.filter((t) => t !== tag);
    setTags(next);
    Commands.updateMetadata(tool.id, { tags: next }).then(onRefresh);
  }, [tags, tool.id, onRefresh]);

  const detected = cv?.manifest.detected ?? [];
  const isQuarantined = cv?.quarantined === true;

  return (
    <div
      className="flex flex-col h-full"
      style={{ background: "#FFFFFF" }}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: "12px",
          padding: "12px 20px",
          borderBottom: "1px solid #E3E7EC",
          background: "#FFFFFF",
        }}
      >
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8 flex-shrink-0">
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="flex-1 min-w-0">
          {editingName ? (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                style={{
                  flex: 1,
                  fontFamily: "Poppins, system-ui, sans-serif",
                  fontWeight: 700, fontSize: "15px",
                  color: "#0A0A0A",
                }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveField("name");
                  if (e.key === "Escape") { setName(tool.name); setEditingName(false); }
                }}
              />
              <Button size="sm" onClick={() => saveField("name")} disabled={saving} className="h-7 px-2">
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setName(tool.name); setEditingName(false); }} className="h-7 px-2">
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <h2
              style={{
                fontFamily: "Poppins, system-ui, sans-serif",
                fontWeight: 700, fontSize: "15px",
                color: "#0A0A0A", letterSpacing: "-0.01em",
                margin: 0, cursor: "pointer",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
              onClick={() => setEditingName(true)}
              title="Click to edit"
            >
              {tool.name}
            </h2>
          )}
        </div>

        <div style={{ display: "flex", gap: "6px", flexShrink: 0, alignItems: "center" }}>
          {/* Update */}
          <Button variant="outline" size="sm" className="gap-1.5"
            onClick={() => { setConfirmDelete(false); setShowUpdate((v) => !v); setUpdateError(null); }}>
            <RefreshCw className="h-3.5 w-3.5" /> Update
          </Button>
          {/* Delete */}
          <Button variant="ghost" size="icon" className="h-8 w-8 text-app-ink-3 hover:text-danger hover:bg-[rgba(210,64,46,.06)]"
            onClick={() => { setShowUpdate(false); setConfirmDelete((v) => !v); }}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          {/* Run */}
          <Button variant="default" size="sm" onClick={() => onRun(tool.id)}
            disabled={isQuarantined || !cv} className="gap-1.5">
            <Play className="h-3.5 w-3.5" /> Run
          </Button>
        </div>
      </div>

      {/* ── Update sub-panel ─────────────────────────────────────────── */}
      {showUpdate && (
        <div style={{
          padding: "10px 20px", background: "#F7F8FA", borderBottom: "1px solid #E3E7EC",
          display: "flex", flexDirection: "column", gap: "8px",
        }}>
          <span style={{ fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, fontSize: "12px", color: "#565B62" }}>
            Add new version from:
          </span>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <Button size="sm" variant="volt" className="gap-1.5" disabled={updating} onClick={handleUpdateClipboard}>
              {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clipboard className="h-3.5 w-3.5" />}
              Paste Clipboard
            </Button>
            <Button size="sm" variant="outline" className="gap-1.5" disabled={updating} onClick={handleUpdateFile}>
              <FolderOpen className="h-3.5 w-3.5" /> Open File…
            </Button>
          </div>
          {updateError && (
            <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "12px", color: "#B0301F", margin: 0 }}>{updateError}</p>
          )}
        </div>
      )}

      {/* ── Delete confirmation ───────────────────────────────────────── */}
      {confirmDelete && (
        <div style={{
          padding: "10px 20px",
          background: "rgba(210,64,46,.06)", borderBottom: "1px solid rgba(210,64,46,.15)",
          display: "flex", alignItems: "center", gap: "12px",
        }}>
          <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px", color: "#B0301F", margin: 0, flex: 1 }}>
            Delete <strong>{tool.name}</strong> and all versions? Cannot be undone.
          </p>
          <Button size="sm" variant="destructive" className="gap-1.5" disabled={deleting} onClick={handleDelete}>
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Delete
          </Button>
          <Button size="sm" variant="ghost" disabled={deleting} onClick={() => setConfirmDelete(false)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* ── Quarantine banner ─────────────────────────────────────────── */}
      {isQuarantined && (
        <div
          style={{
            display: "flex", alignItems: "center", gap: "8px",
            padding: "10px 20px",
            background: "rgba(210,64,46,.08)",
            borderBottom: "1px solid rgba(210,64,46,.15)",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: "13px", color: "#B0301F",
          }}
        >
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <strong>Quarantined.</strong>&nbsp;
          Integrity check failed. Re-ingest a clean copy to restore.
        </div>
      )}

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden" style={{ padding: "0 20px" }}>
        <Tabs defaultValue="permissions" className="h-full flex flex-col pt-4">
          <TabsList>
            <TabsTrigger value="permissions">Permissions</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="versions">Versions ({all_versions.length})</TabsTrigger>
          </TabsList>

          {/* ── PERMISSIONS ──────────────────────────────────────────── */}
          <TabsContent value="permissions" className="flex-1 overflow-auto">
            <ScrollArea className="h-full pr-2">
              <div className="space-y-5 pb-6">

                {/* Capability toggles */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                    <SectionLabel>Access controls</SectionLabel>
                    {approvalSaving && (
                      <span style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "11px", color: "#8A9099", display: "flex", alignItems: "center", gap: "4px" }}>
                        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
                      </span>
                    )}
                  </div>

                  {detected.length === 0 ? (
                    <div style={{
                      background: "rgba(30,158,98,.08)", border: "1px solid rgba(30,158,98,.2)",
                      borderRadius: "8px", padding: "12px 14px",
                      fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px", color: "#137A4B",
                      display: "flex", alignItems: "center", gap: "8px",
                    }}>
                      <Shield className="h-4 w-4 flex-shrink-0" />
                      No special access detected. This tool only renders HTML.
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {detected.map((cap, i) => {
                        const approved = isApproved(cap, approvals);
                        const key = capKey(cap);
                        const plain = capabilityToPlain(cap);
                        const CapIcon = CAP_ICON[key] ?? Settings;
                        const riskNote = capRiskNote(cap);
                        const isNet = typeof cap === "object" && "net" in cap;
                        const hosts = isNet ? (cap as { net: string[] }).net : [];

                        return (
                          <div
                            key={i}
                            style={{
                              background: approved ? "#FFFFFF" : "#F7F8FA",
                              border: approved ? "1px solid #E3E7EC" : "1px solid #E3E7EC",
                              borderRadius: "8px",
                              padding: "12px 14px",
                              transition: "background 0.12s",
                            }}
                          >
                            {/* Row header */}
                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                              <CapIcon size={16} color="#565B62" style={{ flexShrink: 0 }} aria-hidden />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{
                                  fontFamily: "Inter, system-ui, sans-serif",
                                  fontWeight: 600, fontSize: "13px", color: "#0A0A0A",
                                }}>
                                  {plain}
                                </div>
                                {isNet && hosts.length > 0 && (
                                  <div style={{
                                    fontFamily: "'Space Mono', monospace",
                                    fontSize: "10px", color: "#8A9099",
                                    marginTop: "2px",
                                    wordBreak: "break-all",
                                  }}>
                                    {hosts.filter(h => h !== "(dynamic)").join(", ") || "dynamic destinations"}
                                  </div>
                                )}
                              </div>
                              <Switch
                                checked={approved}
                                onCheckedChange={() => handleToggle(cap)}
                                disabled={approvalSaving}
                              />
                            </div>

                            {/* Risk note — shown when being approved */}
                            {approved && riskNote && (
                              <div style={{
                                marginTop: "8px",
                                paddingTop: "8px",
                                borderTop: "1px solid #E3E7EC",
                                display: "flex", gap: "6px", alignItems: "flex-start",
                                fontFamily: "Inter, system-ui, sans-serif",
                                fontSize: "11px", color: "#565B62",
                              }}>
                                <Info className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" style={{ color: "#8A9099" }} />
                                {riskNote}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Live summary of what will actually run */}
                <div style={{
                  borderLeft: "3px solid #FBFF00",
                  paddingLeft: "14px", paddingTop: "8px", paddingBottom: "8px",
                }}>
                  <SectionLabel>When run, this tool can</SectionLabel>
                  {approvals.length === 0 ? (
                    <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px", color: "#0A0A0A", margin: 0 }}>
                      Render HTML only. No network, no device access.
                    </p>
                  ) : (
                    <ul style={{ margin: 0, padding: "0 0 0 16px" }}>
                      {approvals.map((cap, i) => (
                        <li key={i} style={{
                          fontFamily: "Inter, system-ui, sans-serif",
                          fontSize: "13px", color: "#0A0A0A",
                          lineHeight: 1.7,
                        }}>
                          {capabilityToPlain(cap)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "11px", color: "#8A9099", margin: "6px 0 0" }}>
                    Changes apply the next time you run the tool. Close and reopen its window.
                  </p>
                </div>

                {/* Scan limitation note */}
                <div style={{
                  background: "#F7F8FA", border: "1px solid #E3E7EC",
                  borderRadius: "8px", padding: "12px 14px",
                  display: "flex", gap: "10px", alignItems: "flex-start",
                }}>
                  <Shield className="h-4 w-4 flex-shrink-0 mt-0.5" style={{ color: "#565B62" }} />
                  <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "12px", color: "#565B62", margin: 0, lineHeight: 1.5 }}>
                    <strong style={{ color: "#0A0A0A" }}>Scan note:</strong>{" "}
                    The scan uses regular expressions, so eval or obfuscated code can hide
                    capabilities from it. That doesn't grant them: the sandbox only allows what
                    you approve, and the{" "}
                    <code style={{ fontFamily: "'Space Mono', monospace", fontSize: "11px" }}>connect-src</code> CSP
                    blocks network calls you haven't approved.
                  </p>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── DETAILS ──────────────────────────────────────────────── */}
          <TabsContent value="details" className="flex-1 overflow-auto">
            <ScrollArea className="h-full pr-2">
              <div className="space-y-5 pb-6">
                {/* Description */}
                <div>
                  <SectionLabel>Description</SectionLabel>
                  {editingDesc ? (
                    <div className="space-y-2">
                      <textarea
                        autoFocus
                        className="w-full h-20 resize-none"
                        style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px" }}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => saveField("description")} disabled={saving}>Save</Button>
                        <Button size="sm" variant="outline" onClick={() => { setDescription(tool.description); setEditingDesc(false); }}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <p
                      style={{
                        fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px",
                        color: description ? "#0A0A0A" : "#8A9099",
                        cursor: "pointer", margin: 0, lineHeight: 1.6,
                        fontStyle: description ? "normal" : "italic",
                      }}
                      onClick={() => setEditingDesc(true)}
                    >
                      {description || "No description. Click to add one."}
                    </p>
                  )}
                </div>

                <Separator />

                {/* Tags */}
                <div>
                  <SectionLabel><Tag className="inline h-3 w-3 mr-1" />Tags</SectionLabel>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: "4px",
                          fontFamily: "Inter, system-ui, sans-serif", fontSize: "12px",
                          color: "#565B62",
                          background: "#F7F8FA", border: "1px solid #E3E7EC",
                          borderRadius: "4px", padding: "3px 8px",
                        }}
                      >
                        {tag}
                        <button
                          onClick={() => removeTag(tag)}
                          style={{ display: "flex", color: "#8A9099", cursor: "pointer", background: "none", border: "none", padding: 0 }}
                          className="hover:text-danger"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      style={{ width: "110px", fontFamily: "Inter, system-ui, sans-serif", fontSize: "12px" }}
                      placeholder="Add tag…"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); }
                      }}
                    />
                  </div>
                </div>

                <Separator />

                {/* Version metadata — Space Mono for data values */}
                {cv && (
                  <div>
                    <SectionLabel>Current version</SectionLabel>
                    <dl
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto 1fr",
                        gap: "6px 24px",
                      }}
                    >
                      {[
                        ["SHA-256", cv.checksum, true],
                        ["Size",    formatBytes(cv.file_size), true],
                        ["Ingested",formatDate(cv.created_at), false],
                        ["Version", versionLabel(cv), true],
                        ["Signed",  provenanceLabel(provenance), false],
                      ].map(([label, value, isMono]) => (
                        <>
                          <dt key={`dt-${label}`} style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "12px", color: "#8A9099", alignSelf: "baseline" }}>{label}</dt>
                          <dd key={`dd-${label}`} style={{
                            fontFamily: isMono ? "'Space Mono', monospace" : "Inter, system-ui, sans-serif",
                            fontSize: isMono ? "11px" : "13px",
                            color: label === "Signed" && !provenance ? "#92600D" : "#0A0A0A",
                            wordBreak: "break-all", margin: 0,
                          }}>{value as string}</dd>
                        </>
                      ))}
                    </dl>
                    {provenance && (
                      <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "12px", color: "#8A9099", margin: "10px 0 0", lineHeight: 1.5 }}>
                        {SIGNATURE_MEANING} Approve only what you want it to do, above.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ── VERSIONS ─────────────────────────────────────────────── */}
          <TabsContent value="versions" className="flex-1 overflow-auto">
            <ScrollArea className="h-full pr-2">
              <div className="space-y-2 pb-6">
                {all_versions.map((v) => {
                  const isCurrent = v.id === tool.current_ver;
                  return (
                    <div
                      key={v.id}
                      style={{
                        background: isCurrent ? "#F7F8FA" : "#FFFFFF",
                        border: v.quarantined
                          ? "1px solid rgba(210,64,46,.25)"
                          : isCurrent
                            ? "1px solid #E3E7EC"
                            : "1px solid #E3E7EC",
                        borderRadius: "8px",
                        padding: "12px 14px",
                        display: "flex", alignItems: "flex-start",
                        justifyContent: "space-between", gap: "12px",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                          <span style={{ fontFamily: "Poppins, system-ui, sans-serif", fontWeight: 600, fontSize: "13px", color: "#0A0A0A" }}>
                            {versionLabel(v)}
                          </span>
                          {isCurrent && (
                            <span style={{
                              fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500,
                              fontSize: "11px", color: "#137A4B",
                              background: "rgba(30,158,98,.12)",
                              borderRadius: "4px", padding: "1px 7px",
                            }}>current</span>
                          )}
                          {v.quarantined && (
                            <span style={{
                              fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500,
                              fontSize: "11px", color: "#B0301F",
                              background: "rgba(210,64,46,.1)",
                              borderRadius: "4px", padding: "1px 7px",
                              display: "inline-flex", alignItems: "center", gap: "4px",
                            }}>
                              <AlertTriangle className="h-3 w-3" /> quarantined
                            </span>
                          )}
                        </div>
                        {/* Hash — Space Mono (it's data) */}
                        <p style={{ fontFamily: "'Space Mono', monospace", fontSize: "10px", color: "#8A9099", margin: "0 0 4px", wordBreak: "break-all" }}>
                          {v.checksum}
                        </p>
                        <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "12px", color: "#8A9099", margin: 0, display: "flex", alignItems: "center", gap: "4px" }}>
                          <Clock className="h-3 w-3" />
                          {formatDate(v.created_at)} · {formatBytes(v.file_size)}
                        </p>
                      </div>
                      {!isCurrent && !v.quarantined && (
                        <Button variant="outline" size="sm" className="h-7 gap-1.5 flex-shrink-0" disabled={rolling} onClick={() => rollback(v)}>
                          <RotateCcw className="h-3 w-3" /> Restore
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
