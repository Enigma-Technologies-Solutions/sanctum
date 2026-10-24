// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { PageHeader } from "@/components/PageHeader";
import { useState, useEffect, useCallback } from "react";
import type { ToolWithVersion, IngestResult, BundleInstall, PolicyStatus } from "@/lib/types";
import { Commands } from "@/lib/commands";
import { ToolCard } from "./ToolCard";
import { WelcomePanel } from "./WelcomePanel";
import { CreateAppCard } from "./CreateAppCard";
import { IngestBar } from "./IngestBar";
import { InspectView } from "./InspectView";
import { ScrollArea } from "@/components/ui/scroll-area";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, BadgeCheck, FileCode, HelpCircle, Loader2, Layers } from "lucide-react";
import { SectionHeader, Dot } from "./SectionHeader";
import { groupByPublisher } from "@/lib/vault";
import { LIBRARY_EVENT } from "@/lib/agent";

/** Dashed card in "Your tools" while you have not added a tool of your own. */
function EmptySlot() {
  return (
    <div
      data-testid="empty-slot"
      style={{
        minHeight: "190px",
        border: "2px dashed var(--app-border-2)",
        borderRadius: "10px",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: "10px", padding: "24px", textAlign: "center",
      }}
    >
      <div
        style={{
          width: "44px", height: "44px",
          background: "var(--app-raised)", borderRadius: "12px",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <Layers className="h-5 w-5" aria-hidden="true" style={{ color: "var(--app-mute)" }} />
      </div>
      <p
        style={{
          fontFamily: "Poppins, system-ui, sans-serif",
          fontWeight: 600, fontSize: "15px",
          color: "var(--app-ink)", margin: 0, letterSpacing: "-0.01em",
        }}
      >
        Your first tool will appear here
      </p>
      <p
        style={{
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: "12.5px", color: "var(--app-ink-2)",
          maxWidth: "280px", margin: 0, lineHeight: 1.5,
        }}
      >
        Use Paste from Clipboard or Open File above, or drop a .html file into this window. Signed
        tools are grouped under their publisher below. Find some in the Catalogue.
      </p>
    </div>
  );
}

export function Library({ refreshKey = 0, onOpenCatalogue }: { refreshKey?: number; onOpenCatalogue?: () => void }) {
  const [tools, setTools] = useState<ToolWithVersion[]>([]);
  const [ingestError, setIngestError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PolicyStatus | null>(null);

  useEffect(() => {
    Commands.getPolicyStatus().then(setPolicy).catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await Commands.listTools();
      setTools(data);
    } catch (e) {
      console.error("list_tools:", e);
    }
  }, []);

  // A draft was added from the Create window.
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    listen(LIBRARY_EVENT, () => void refresh())
      .then((u) => (gone ? u() : (off = u)))
      .catch(() => {});
    return () => {
      gone = true;
      off?.();
    };
  }, [refresh]);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    // Reload when something was installed elsewhere (the catalogue).
  }, [refresh, refreshKey]);

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
        (p) => p.endsWith(".html") || p.endsWith(".htm") || p.endsWith(".sanctum")
      );
      setRunError(null);
      htmlPaths.forEach((path) => {
        (path.endsWith(".sanctum")
          ? Commands.ingestBundleFromPath(path)
          : Commands.ingestFromPath(path))
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
        {
          tool: result.tool,
          current_version: result.version,
          all_versions: [result.version],
          // Only bundle installs carry provenance; a loose file does not.
          provenance: "provenance" in result ? (result as BundleInstall).provenance : null,
        },
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

  // "Your tools" holds what you pasted or opened without a signature. Everything signed is
  // grouped by publisher below it.
  const allGroups = groupByPublisher(tools);
  const ownTools = allGroups.find((g) => g.kind === "unsigned")?.tools ?? [];
  const publisherGroups = allGroups.filter((g) => g.kind !== "unsigned");

  const inspectedItem = inspecting ? tools.find((t) => t.tool.id === inspecting) ?? null : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2" style={{ color: "var(--app-mute)" }}>
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: "var(--app-ink)" }} />
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
      style={{ background: "var(--app-bg)" }}
    >
      <PageHeader title="Installed tools">
        Tools you have added to Sanctum. Each one runs in its own sandbox and gets only the access you approve.
      </PageHeader>

      {/* Tool grid */}
      <ScrollArea className="flex-1" style={{ background: "var(--app-surface)" }}>
        <div style={{ padding: "20px 24px 24px" }}>
          {tools.length === 0 && onOpenCatalogue && <WelcomePanel onOpenCatalogue={onOpenCatalogue} />}
          <section aria-labelledby="your-tools">
            <SectionHeader
              id="your-tools"
              title="Your tools"
              meta={
                <>
                  <FileCode size={13} aria-hidden="true" />
                  <span>Pasted or opened by you, not signed</span>
                  <Dot />
                  <span>{ownTools.length} {ownTools.length === 1 ? "tool" : "tools"}</span>
                </>
              }
              actions={<IngestBar onIngested={handleIngested} onError={setIngestError} />}
            />
            {ingestError && (
              <div
                role="alert"
                style={{
                  marginTop: "10px",
                  display: "flex", alignItems: "flex-start", gap: "6px",
                  background: "rgba(210,64,46,.08)",
                  border: "1px solid rgba(210,64,46,.2)",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: "12px", color: "var(--danger-ink)",
                }}
              >
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
                <span>{ingestError}</span>
              </div>
            )}
            {policy?.managed && (
              <div
                style={{
                  marginTop: "10px",
                  background: policy.error ? "rgba(210,64,46,.08)" : "var(--app-bg)",
                  border: `1px solid ${policy.error ? "rgba(210,64,46,.2)" : "var(--app-border)"}`,
                  borderRadius: "6px",
                  padding: "8px 12px",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: "12px",
                  color: policy.error ? "var(--danger-ink)" : "var(--app-ink-1)",
                }}
              >
                {policy.error
                  ? `Your organisation's policy could not be applied, so tools are blocked. ${policy.error}`
                  : policy.pinnedCount !== null
                    ? `Your organisation limits which tools can run. ${policy.pinnedCount} approved ${policy.pinnedCount === 1 ? "version" : "versions"}. Other tools can be added but will not open.`
                    : "Your organisation manages this installation."}
              </div>
            )}

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
                  fontSize: "12px", color: "var(--danger-ink)",
                }}
              >
                {runError}
              </div>
            )}


            <div
              style={{
                marginTop: "12px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                gap: "16px",
              }}
            >
              {ownTools.map((item) => (
                <ToolCard
                  key={item.tool.id}
                  item={item}
                  onRun={handleRun}
                  onInspect={setInspecting}
                  onDeleted={handleDelete}
                  onUpdated={(toolId) => refreshTool(toolId)}
                />
              ))}
              {ownTools.length === 0 && <EmptySlot />}
              <CreateAppCard />
            </div>
          </section>

          {publisherGroups.length > 0 && (
            <div style={{ borderTop: "1px solid var(--app-border)", marginTop: "24px", paddingTop: "20px", display: "grid", gap: "28px" }}>
              {publisherGroups.map((g) => {
                const Icon = g.kind === "verified" ? BadgeCheck : HelpCircle;
                const how = g.kind === "verified" ? "Verified publisher" : "Signed by a key Sanctum does not recognise";
                return (
                  <section key={g.key} aria-labelledby={`grp-${g.key}`}>
                    <div style={{ marginBottom: "12px" }}>
                      <SectionHeader
                        id={`grp-${g.key}`}
                        title={g.title}
                        meta={
                          <>
                            <Icon size={13} aria-hidden="true" />
                            <span>{how}</span>
                            <Dot />
                            <span>{g.tools.length} {g.tools.length === 1 ? "tool" : "tools"}</span>
                          </>
                        }
                      />
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                        gap: "16px",
                      }}
                    >
                      {g.tools.map((item) => (
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
                  </section>
                );
              })}
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
            border: "2px solid var(--app-ink)",
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
              color: "var(--app-ink)", margin: 0, letterSpacing: "-0.01em",
            }}
          >
            Drop to add
          </h2>
          <p style={{ fontFamily: "Inter, system-ui, sans-serif", fontSize: "13px", color: "var(--app-ink-2)", margin: 0 }}>
            .html and .sanctum files
          </p>
        </div>
      )}
    </div>
  );
}
