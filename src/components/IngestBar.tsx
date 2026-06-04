// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Commands } from "@/lib/commands";
import type { IngestResult } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Clipboard, FolderOpen, Loader2, AlertTriangle } from "lucide-react";

interface IngestBarProps {
  onIngested: (result: IngestResult) => void;
}

export function IngestBar({ onIngested }: IngestBarProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePaste = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await Commands.ingestFromClipboard();
      onIngested(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onIngested]);

  const handleOpen = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const selected = await open({
        title: "Open HTML Tool",
        filters: [{ name: "HTML", extensions: ["html", "htm"] }],
        multiple: false,
        directory: false,
      });
      if (!selected) { setBusy(false); return; }
      const path = Array.isArray(selected) ? selected[0] : selected;
      const result = await Commands.ingestFromPath(path);
      onIngested(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onIngested]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Volt CTA — the single prominent action */}
        <Button onClick={handlePaste} disabled={busy} variant="volt" size="sm" className="gap-2">
          {busy
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Clipboard className="h-3.5 w-3.5" />
          }
          Paste from Clipboard
        </Button>

        {/* Secondary — ghost outline */}
        <Button onClick={handleOpen} disabled={busy} variant="outline" size="sm" className="gap-2">
          <FolderOpen className="h-3.5 w-3.5" />
          Open File…
        </Button>

        <span
          style={{
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: "12px",
            color: "#8A9099",
          }}
        >
          or drop a <code style={{ fontFamily: "'Space Mono', monospace", fontSize: "11px" }}>.html</code> file here
        </span>
      </div>

      {error && (
        <div
          style={{
            display: "flex", alignItems: "flex-start", gap: "6px",
            background: "rgba(210,64,46,.08)",
            border: "1px solid rgba(210,64,46,.2)",
            borderRadius: "6px",
            padding: "8px 12px",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: "12px", color: "#B0301F",
          }}
        >
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
