// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useState } from "react";
import { ListChecks, Loader2, Search, ShieldCheck, Store } from "lucide-react";
import { Commands } from "@/lib/commands";
import { asRegistryError, ENIGMA_REGISTRY_URL, errorHint } from "@/lib/registry";
import { Button } from "@/components/ui/button";

const font = "'Inter', system-ui, sans-serif";

const STEPS = [
  { Icon: Search, title: "Pick a tool", text: "Install a signed tool from the Catalogue, or paste one a model wrote for you." },
  { Icon: ListChecks, title: "See what it asks for", text: "Sanctum lists the camera, network hosts and other access a tool uses before it runs." },
  { Icon: ShieldCheck, title: "Approve only what you need", text: "Anything you do not approve stays blocked." },
];

/**
 * What a new person sees in an empty Tool Vault: what Sanctum is in two sentences, one obvious
 * first step, and the three things that happen next. The first step makes one request, and
 * only when it is clicked: it adds the Enigma registry (whose signed list Sanctum then checks)
 * and opens the Catalogue. Nothing is installed by it.
 */
export function WelcomePanel({ onOpenCatalogue }: { onOpenCatalogue: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string | null } | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const have = await Commands.listRegistries();
      if (!have.some((r) => r.baseUrl === ENIGMA_REGISTRY_URL)) {
        await Commands.addRegistry(ENIGMA_REGISTRY_URL);
      }
      onOpenCatalogue();
    } catch (e) {
      const err = asRegistryError(e);
      setError({ message: err.message, hint: errorHint(err.code) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="welcome-title"
      style={{
        marginBottom: 24,
        padding: 24,
        background: "var(--app-bg)",
        border: "1px solid var(--app-border)",
        borderRadius: 10,
      }}
    >
      <h2 id="welcome-title" style={{ margin: 0, fontFamily: "Poppins, system-ui, sans-serif", fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em" }}>
        Welcome to Sanctum
      </h2>
      <p style={{ margin: "6px 0 16px", fontFamily: font, fontSize: 13.5, color: "var(--app-ink-1)", maxWidth: "62ch", lineHeight: 1.5 }}>
        Sanctum runs small HTML tools in a sandbox. Every tool starts with no access, and you approve only what it needs.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Button variant="volt" onClick={() => void start()} disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Store className="h-4 w-4" aria-hidden="true" />}
          {busy ? "Getting the list…" : "Browse signed tools"}
        </Button>
        <span style={{ fontFamily: font, fontSize: 12, color: "var(--app-ink-2)" }}>
          Downloads Enigma's signed list of tools. Nothing is installed until you choose.
        </span>
      </div>

      {error && (
        <div role="alert" style={{ marginTop: 12, fontFamily: font, fontSize: 12, color: "var(--danger-ink)" }}>
          <div>{error.message}</div>
          {error.hint && <div style={{ marginTop: 4, color: "var(--app-ink-2)" }}>{error.hint}</div>}
        </div>
      )}

      <p style={{ margin: "14px 0 0", fontFamily: font, fontSize: 12.5, color: "var(--app-ink-2)" }}>
        Or add your own: paste, open or drop an HTML file below.
      </p>

      <ol
        aria-label="How it works"
        style={{ listStyle: "none", margin: "20px 0 0", padding: 0, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}
      >
        {STEPS.map(({ Icon, title, text }, i) => (
          <li key={title} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span
              aria-hidden="true"
              style={{ display: "inline-flex", width: 28, height: 28, flexShrink: 0, alignItems: "center", justifyContent: "center", border: "1px solid var(--app-border)", borderRadius: 6, background: "var(--app-surface)" }}
            >
              <Icon size={15} />
            </span>
            <div>
              <div style={{ fontFamily: font, fontSize: 13, fontWeight: 600 }}>
                {i + 1}. {title}
              </div>
              <div style={{ fontFamily: font, fontSize: 12.5, color: "var(--app-ink-2)", marginTop: 2, lineHeight: 1.45 }}>{text}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
