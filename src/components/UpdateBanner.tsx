// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState, useEffect, useCallback } from "react";
import type { UpdateInfo } from "@/lib/types";
import { Commands } from "@/lib/commands";
import { Loader2, ArrowUpCircle } from "lucide-react";

/**
 * Update notice for the host UI.
 *
 * Deliberately non-modal and never auto-installing: a security tool that
 * replaces its own binary without the user saying so is doing the thing it
 * warns other software about. The check runs once on mount; the install only
 * runs on an explicit click.
 *
 * A failed check is surfaced rather than swallowed — silently degrading to
 * "never updates again" is the worst outcome for a patch channel.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Commands.checkForUpdate()
      .then((result) => {
        if (!cancelled) setUpdate(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const install = useCallback(() => {
    setInstalling(true);
    setError(null);
    // On success the process is replaced, so only the failure path returns.
    Commands.installUpdate().catch((e: unknown) => {
      setError(String(e));
      setInstalling(false);
    });
  }, []);

  if (!update && !error) return null;

  const isError = !update && error !== null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "10px 20px",
        flexShrink: 0,
        // Volt fill always carries black ink; the error state drops to a
        // neutral surface rather than repurposing the brand accent as a warning.
        background: isError ? "#F7F8FA" : "#FBFF00",
        color: "#0A0A0A",
        borderBottom: "1px solid #E3E7EC",
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: "13px",
      }}
    >
      <ArrowUpCircle size={15} style={{ flexShrink: 0, opacity: isError ? 0.45 : 1 }} />

      {isError ? (
        <span style={{ color: "#5A6069" }}>Update check failed: {error}</span>
      ) : (
        <>
          <span>
            <strong style={{ fontWeight: 600 }}>Sanctum {update!.version}</strong> is available.
            <span style={{ opacity: 0.65 }}>
              {" "}
              You are on {update!.current_version}.
            </span>
          </span>

          <div style={{ flex: 1 }} />

          {error && (
            <span
              style={{
                fontFamily: "'Space Mono', ui-monospace, monospace",
                fontSize: "11px",
                opacity: 0.7,
              }}
            >
              {error}
            </span>
          )}

          <button
            onClick={install}
            disabled={installing}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#0A0A0A",
              color: "#FFFFFF",
              border: "none",
              padding: "6px 14px",
              fontSize: "12px",
              fontWeight: 500,
              fontFamily: "'Inter', system-ui, sans-serif",
              cursor: installing ? "default" : "pointer",
              opacity: installing ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            {installing && <Loader2 size={12} className="animate-spin" />}
            {installing ? "Installing…" : "Install and restart"}
          </button>
        </>
      )}
    </div>
  );
}
