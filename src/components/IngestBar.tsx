// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Commands } from "@/lib/commands";
import type { IngestResult } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Clipboard, FolderOpen, Loader2 } from "lucide-react";

interface IngestBarProps {
  onIngested: (result: IngestResult) => void;
  /** Called with the failure message, or null when a new attempt starts. */
  onError: (message: string | null) => void;
}

export function IngestBar({ onIngested, onError }: IngestBarProps) {
  const [busy, setBusy] = useState(false);
  const setError = onError;

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
  }, [onIngested, setError]);

  const handleOpen = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const selected = await open({
        title: "Open HTML Tool",
        filters: [
          { name: "HTML or signed bundle", extensions: ["html", "htm", "sanctum"] },
        ],
        multiple: false,
        directory: false,
      });
      if (!selected) { setBusy(false); return; }
      const path = Array.isArray(selected) ? selected[0] : selected;
      const result = path.endsWith(".sanctum")
        ? await Commands.ingestBundleFromPath(path)
        : await Commands.ingestFromPath(path);
      onIngested(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [onIngested, setError]);

  return (
    <>
      {/* Volt CTA: the single prominent action */}
      <Button onClick={handlePaste} disabled={busy} variant="volt" size="sm" className="gap-2">
        {busy
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Clipboard className="h-3.5 w-3.5" />
        }
        Paste from Clipboard
      </Button>

      {/* Secondary: ghost outline */}
      <Button onClick={handleOpen} disabled={busy} variant="outline" size="sm" className="gap-2">
        <FolderOpen className="h-3.5 w-3.5" />
        Open File…
      </Button>
    </>
  );
}
