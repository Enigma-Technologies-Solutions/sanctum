// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useEffect, useState } from "react";
import { BookOpen, FileCode, Loader2, ScrollText } from "lucide-react";
import { useInstructions } from "@/lib/agent";
import { type ChatSource } from "@/lib/types";
import { Button } from "@/components/ui/button";

const font = "'Inter', system-ui, sans-serif";
const MAX_INSTRUCTIONS = 4000;

const ICONS = { app: FileCode, guide: BookOpen, instructions: ScrollText } as const;

const note = { margin: 0, fontFamily: font, fontSize: 12, color: "var(--app-ink-2)", lineHeight: 1.5 } as const;

/**
 * Your standing instructions: text added to the rules of every new conversation, for things you
 * always want in the apps Codex makes (where files go, a language, a look). It sits below
 * Sanctum's own rules, so it shapes what Codex writes and cannot loosen the sandbox.
 */
function Instructions() {
  const ins = useInstructions();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (ins.text !== null) setDraft(ins.text);
  }, [ins.text]);
  const changed = ins.text !== null && draft.trim() !== ins.text.trim();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={{ alignSelf: "flex-start" }}>
        {open ? "Hide your instructions" : ins.text ? "Edit your instructions" : "Add your instructions"}
      </Button>
      {open && (
        <>
          <textarea
            aria-label="Your instructions for every app"
            value={draft}
            maxLength={MAX_INSTRUCTIONS}
            rows={7}
            disabled={ins.text === null}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="For example: when an app makes a file, save it to my Downloads folder and say so."
            style={{ resize: "vertical", fontFamily: font, fontSize: 12.5, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--app-border-2)", background: "var(--app-surface)", color: "var(--app-ink)" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Button size="sm" variant="outline" disabled={!changed || ins.saving} onClick={() => void ins.save(draft)}>
              {ins.saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Save
            </Button>
            <span style={{ ...note, fontSize: 11.5 }}>{`${draft.length} of ${MAX_INSTRUCTIONS}`}</span>
          </div>
          {ins.saved && !changed && (
            <p role="status" style={note}>
              Saved. It applies to conversations you start from now on.
            </p>
          )}
          {ins.error && (
            <p role="alert" style={{ ...note, color: "var(--danger-ink)" }}>
              {ins.error}
            </p>
          )}
          <p style={{ ...note, fontSize: 11.5 }}>
            Sanctum's rules come first and always win. These are sent to OpenAI with each conversation.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * What Codex was given to read before your first message: the app you are changing (if any),
 * Sanctum's guide, and your own instructions. Shown so nothing in the conversation depends on
 * context you cannot see.
 */
export function CreateSources({ sources }: { sources: ChatSource[] }) {
  return (
    <aside
      aria-label="Sources"
      data-testid="sources"
      style={{ width: 260, flexShrink: 0, borderLeft: "1px solid var(--app-border)", padding: "16px 16px", overflowY: "auto", background: "var(--app-bg)", display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div>
        <h2 style={{ margin: 0, fontFamily: "Poppins, system-ui, sans-serif", fontSize: 14, fontWeight: 600, color: "var(--app-ink)" }}>Sources</h2>
        <p style={{ ...note, marginTop: 4 }}>What Codex has read for this conversation.</p>
      </div>
      {sources.length === 0 && (
        <p role="status" style={note}>
          Getting ready…
        </p>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 12 }}>
        {sources.map((s) => {
          const Icon = ICONS[s.kind];
          return (
            <li key={`${s.kind}-${s.toolId ?? ""}`} data-testid={`source-${s.kind}`} style={{ display: "flex", gap: 10 }}>
              <Icon className="h-4 w-4" aria-hidden="true" style={{ flexShrink: 0, marginTop: 2, color: "var(--app-mute)" }} />
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                <strong style={{ fontFamily: font, fontSize: 13, color: "var(--app-ink)", overflowWrap: "anywhere" }}>{s.title}</strong>
                {s.kind === "app" && <span style={{ ...note, color: "var(--app-ink)" }}>You are changing this app.</span>}
                <span style={note}>{s.detail}</span>
                {s.kind === "instructions" && <Instructions />}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
