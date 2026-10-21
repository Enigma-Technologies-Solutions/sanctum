// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { Loader2, LogIn, PencilRuler } from "lucide-react";
import { downloadLabel, signInNote, useAgent } from "@/lib/agent";
import { Button } from "@/components/ui/button";

const font = "'Inter', system-ui, sans-serif";

/**
 * A card in "Your tools" for making a tool of your own. For now it only signs you in to ChatGPT
 * (the first sign-in downloads Codex, which the note says before anything is clicked). It is not
 * shown on a computer Sanctum has no Codex build for. Nothing runs and nothing is downloaded
 * until the button is clicked.
 */
export function CreateAppCard() {
  const agent = useAgent({ readAccount: false });
  if (!agent.setup?.supported) return null;

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

        {agent.account?.signedIn ? (
          <p role="status" style={{ margin: 0, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", lineHeight: 1.5 }}>
            Signed in to ChatGPT as {agent.account.email}
            {agent.account.plan ? ` (${agent.account.plan})` : ""}.
          </p>
        ) : agent.signingIn ? (
          <>
            <p role="status" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)" }}>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {agent.phase === "downloading" ? downloadLabel(agent.download) : "Finish signing in in your browser…"}
            </p>
            <div>
              <Button variant="ghost" size="sm" onClick={agent.cancel}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", lineHeight: 1.5 }}>
              {signInNote(agent.setup)}
            </p>
            <div>
              <Button variant="outline" onClick={() => void agent.signIn()}>
                <LogIn className="h-4 w-4" aria-hidden="true" />
                Sign in with ChatGPT
              </Button>
            </div>
          </>
        )}

        {agent.error && (
          <div role="alert" style={{ fontFamily: font, fontSize: 12, color: "var(--danger-ink)" }}>
            {agent.error}
          </div>
        )}
      </div>
    </div>
  );
}
