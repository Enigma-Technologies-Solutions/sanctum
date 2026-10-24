// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState } from "react";
import { ArrowRight, PencilRuler } from "lucide-react";
import { Commands } from "@/lib/commands";
import { asAgentError, downloadNote, useAgentSetup } from "@/lib/agent";
import { Button } from "@/components/ui/button";

const font = "'Inter', system-ui, sans-serif";

/**
 * A card in "Your tools" for making a tool of your own. It opens the Create window, where the
 * sign-in and the chat live, so the conversation stays open while you use the rest of Sanctum.
 * Not shown on a computer Sanctum has no Codex build for, or until the person turns building
 * apps on in Settings. Looking reads files only: nothing is downloaded or started until the
 * person opens the window.
 */
export function CreateAppCard() {
  const setup = useAgentSetup();
  const [error, setError] = useState<string | null>(null);
  if (!setup?.supported || !setup.enabled) return null;
  const note = downloadNote(setup);

  return (
    <div className="tool-card" data-testid="create-app-card">
      <div style={{ padding: "18px 18px 16px", display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            aria-hidden="true"
            style={{
              width: 40, height: 40, flexShrink: 0,
              background: "var(--app-surface)", border: "1px solid var(--app-border)", borderRadius: 9,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <PencilRuler className="h-5 w-5" style={{ color: "var(--app-mute)" }} />
          </div>
          <h3
            style={{
              fontFamily: "Poppins, system-ui, sans-serif",
              fontWeight: 600, fontSize: 15, color: "var(--app-ink)",
              letterSpacing: "-0.01em", lineHeight: 1.3, margin: 0,
            }}
          >
            Create your own app
          </h3>
        </div>
        <p style={{ margin: 0, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", lineHeight: 1.5 }}>
          Describe a tool in plain words and Codex writes it for you, using your ChatGPT account.
          {note ? ` ${note}` : ""}
        </p>
        <div>
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              Commands.agentOpenCreateWindow().catch((e: unknown) => setError(asAgentError(e).message));
            }}
          >
            Start building
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
        {error && (
          <div role="alert" style={{ fontFamily: font, fontSize: 12, color: "var(--danger-ink)" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
