// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, useEffect, useCallback } from "react";
import type { ToolWithVersion, IngestResult } from "@/lib/types";
import { Commands } from "@/lib/commands";
import { ToolCard } from "./ToolCard";
import { IngestBar } from "./IngestBar";
import { InspectView } from "./InspectView";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listen } from "@tauri-apps/api/event";
import { Loader2, Layers } from "lucide-react";

export function Library() {
  const [tools, setTools] = useState<ToolWithVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await Commands.listTools();
      setTools(data);
    } catch (e) {
      console.error("list_tools:", e);
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const refreshTool = useCallback(async (toolId: string) => {
    try {
      const updated = await Commands.getTool(toolId);
      setTools((prev) => prev.map((t) => (t.tool.id === toolId ? updated : t)));
    } catch {}
  }, []);

  useEffect(() => {
    type DropPayload = { paths: string[] };
    const unlisteners: Array<() => void> = [];

    listen<DropPayload>("tauri://file-drop", ({ payload }) => {
      setDragOver(false);
      const htmlPaths = (payload?.paths ?? []).filter(
        (p) => p.endsWith(".html") || p.endsWith(".htm")
      );
      setRunError(null);
      htmlPaths.forEach((path) => {
        Commands.ingestFromPath(path)
          .then(handleIngested)
          .catch((e) => setRunError(String(e)));
      });
    }).then((u) => unlisteners.push(u));

    listen("tauri://file-drop-hover", () => setDragOver(true)).then((u) => unlisteners.push(u));
    listen("tauri://file-drop-cancelled", () => setDragOver(false)).then((u) => unlisteners.push(u));

    return () => unlisteners.forEach((u) => u());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleIngested = useCallback((result: IngestResult) => {
    if (result.isNewTool) {
      setTools((prev) => [
        { tool: result.tool, current_version: result.version, all_versions: [result.version] },
        ...prev,
      ]);
    } else {
      refreshTool(result.tool.id);
    }
  }, [refreshTool]);

  const handleRun = useCallback(async (toolId: string) => {
    setRunError(null);
    try { await Commands.openToolWindow(toolId); }
    catch (e) { setRunError(String(e)); }
  }, []);

  const handleDelete = useCallback((toolId: string) => {
    setTools((prev) => prev.filter((t) => t.tool.id !== toolId));
    // If we were inspecting this tool, go back to library
    if (inspecting === toolId) setInspecting(null);
  }, [inspecting]);

  const inspectedItem = inspecting ? tools.find((t) => t.tool.id === inspecting) ?? null : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2" style={{ color: "#8A9099" }}>
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: "#0A0A0A" }} />
        <span style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px" }}>
          Loading vault…
        </span>
      </div>
    );
  }

  if (inspectedItem) {
    return (
      <InspectView
        item={inspectedItem}
        onBack={() => setInspecting(null)}
        onRun={handleRun}
        onRefresh={() => refreshTool(inspectedItem.tool.id)}
        onDelete={handleDelete}
      />
    );
  }

  return (
    <div
      className={`flex flex-col h-full relative ${dragOver ? "drag-over" : ""}`}
      style={{ background: "#FFFFFF" }}
    >
      {/* Toolbar */}
      <div
        style={{
          padding: "20px 24px 16px",
          borderBottom: "1px solid #E3E7EC",
          background: "#FFFFFF",
        }}
      >
        {/* Section kicker */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
          <div className="volt-bar" style={{ width: "32px" }} />
          <span
            style={{
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: "11px", fontWeight: 600,
              color: "#8A9099", textTransform: "uppercase", letterSpacing: "0.1em",
            }}
          >
            Tool Vault
          </span>
          {tools.length > 0 && (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: "12px", color: "#8A9099",
              }}
            >
              {tools.length} {tools.length === 1 ? "tool" : "tools"}
            </span>
          )}
        </div>

        {/* Section heading */}
        <h1
          style={{
            fontFamily: "Poppins, system-ui, sans-serif",
            fontWeight: 700, fontSize: "20px",
            color: "#0A0A0A", letterSpacing: "-0.01em",
            margin: "0 0 4px",
          }}
        >
          Ingested Tools
        </h1>
        {/* Volt accent bar — no radius, stays sharp */}
        <div className="volt-bar" style={{ width: "48px", marginBottom: "16px" }} />

        <IngestBar onIngested={handleIngested} />

        {runError && (
          <div
            style={{
              marginTop: "10px",
              display: "flex", alignItems: "flex-start", gap: "6px",
              background: "rgba(210,64,46,.08)",
              border: "1px solid rgba(210,64,46,.2)",
              borderRadius: "6px",
              padding: "8px 12px",
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: "12px", color: "#B0301F",
            }}
          >
            {runError}
          </div>
        )}
      </div>

      {/* Tool grid */}
      <ScrollArea className="flex-1" style={{ background: "#F7F8FA" }}>
        <div style={{ padding: "20px 24px 24px" }}>
          {tools.length === 0 ? (
            <div
              style={{
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                minHeight: "280px", gap: "16px",
              }}
            >
              <div
                style={{
                  width: "48px", height: "48px",
                  background: "#EEF1F4", borderRadius: "12px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <Layers className="h-6 w-6" style={{ color: "#8A9099" }} />
              </div>
              <div style={{ textAlign: "center" }}>
                <h2
                  style={{
                    fontFamily: "Poppins, system-ui, sans-serif",
                    fontWeight: 600, fontSize: "16px",
                    color: "#0A0A0A", margin: "0 0 6px",
                    letterSpacing: "-0.01em",
                  }}
                >
                  Vault is empty
                </h2>
                <p
                  style={{
                    fontFamily: "Inter, system-ui, sans-serif",
                    fontSize: "13px", color: "#565B62",
                    maxWidth: "320px", margin: 0, lineHeight: 1.5,
                  }}
                >
                  Copy an AI-generated HTML tool, then click{" "}
                  <strong>Paste from Clipboard</strong>. Or drag a{" "}
                  <code style={{ fontFamily: "'Space Mono', monospace", fontSize: "12px" }}>.html</code>{" "}
                  file into this window.
                </p>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                gap: "12px",
              }}
            >
              {tools.map((item) => (
                <ToolCard
                  key={item.tool.id}
                  item={item}
                  onRun={handleRun}
                  onInspect={setInspecting}
                  onDeleted={handleDelete}
                  onUpdated={(toolId) => refreshTool(toolId)}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Drag-over overlay */}
      {dragOver && (
        <div
          style={{
            position: "absolute", inset: 0,
            background: "rgba(247,248,250,.92)",
            border: "2px solid #0A0A0A",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            gap: "8px",
            pointerEvents: "none", zIndex: 10,
          }}
        >
          <h2
            style={{
              fontFamily: "Poppins, system-ui, sans-serif",
              fontWeight: 700, fontSize: "18px",
              color: "#0A0A0A", margin: 0, letterSpacing: "-0.01em",
            }}
          >
            Drop to Ingest
          </h2>
          <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px", color: "#565B62", margin: 0 }}>
            .html files only
          </p>
        </div>
      )}
    </div>
  );
}
