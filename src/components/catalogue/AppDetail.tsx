// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, BadgeCheck, Check, Copy, Loader2, Package, RefreshCw } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Commands } from "@/lib/commands";
import { capabilityToPlain } from "@/lib/types";
import type { RegistryAppDetail, RegistryCatalogApp, RegistrySummary } from "@/lib/types";
import { actionFor, asRegistryError, errorHint, formatDate, latestScope, REGISTRY_MEANING } from "@/lib/registry";
import { Button } from "@/components/ui/button";
import { Markdown } from "./Markdown";

const font = "'Inter', system-ui, sans-serif";
const mono = "'Space Mono', ui-monospace, monospace";

const CHANGE_LABEL = { added: "Added", changed: "Changed", fixed: "Fixed", security: "Security", removed: "Removed" } as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} style={{ marginTop: 28 }}>
      <h2 id={id} style={{ margin: "0 0 10px", fontFamily: "Poppins, system-ui, sans-serif", fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: font, fontSize: 12 }}>
      <span style={{ color: "var(--app-ink-2)", minWidth: 56 }}>{label}</span>
      <span style={{ fontFamily: mono, fontSize: 11, wordBreak: "break-all" }}>{value}</span>
      <button
        type="button"
        aria-label={`Copy ${label.toLowerCase()} address`}
        onClick={async () => {
          try {
            await writeText(value);
            setState("done");
          } catch {
            setState("failed");
          }
          setTimeout(() => setState("idle"), 1800);
        }}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: "var(--app-bg)", border: "1px solid var(--app-border)", borderRadius: 6, fontFamily: font, fontSize: 11, cursor: "pointer" }}
      >
        {state === "done" ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
        {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
    </div>
  );
}

interface Props {
  registry: RegistrySummary;
  app: RegistryCatalogApp;
  /** An install of this app is running. */
  busy: boolean;
  paused: boolean;
  onBack: () => void;
  onInstall: (app: RegistryCatalogApp) => void;
}

/**
 * The detail page: what the app is, what it asks for (before anything is installed), what
 * changed, how to use it, and what it looks like. All of it was verified against the signed
 * index in Rust before it got here.
 */
export function AppDetail({ registry, app, busy, paused, onBack, onInstall }: Props) {
  const [detail, setDetail] = useState<RegistryAppDetail | null>(null);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Commands.registryAppDetail(registry.id, app.appId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => {
        if (cancelled) return;
        const err = asRegistryError(e);
        setError({ message: err.message, code: err.code });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [registry.id, app.appId]);

  useEffect(() => load(), [load]);

  const action = actionFor(app);
  const scope = latestScope(app);
  const titleId = "app-detail-title";

  return (
    <div style={{ padding: "20px 24px 40px", maxWidth: 880 }}>
      <Button variant="ghost" size="sm" onClick={onBack} style={{ marginLeft: -8, marginBottom: 8 }}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Catalogue
      </Button>

      <header style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <span aria-hidden="true" style={{ display: "inline-flex", width: 56, height: 56, alignItems: "center", justifyContent: "center", background: "var(--app-surface)", border: "1px solid var(--app-border)", borderRadius: 12, overflow: "hidden", flexShrink: 0 }}>
          {detail?.icon ? <img src={detail.icon} alt="" width={56} height={56} /> : <Package size={24} />}
        </span>
        <div>
          <h1 id={titleId} style={{ margin: 0, fontFamily: "Poppins, system-ui, sans-serif", fontSize: 24, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {app.name} <span style={{ fontFamily: mono, fontSize: 12, fontWeight: 400, color: "var(--app-ink-2)" }}>v{app.latest}</span>
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)" }}>
            <BadgeCheck size={14} aria-hidden="true" />
            <span>
              {registry.trust === "pinned" ? "From a key you pinned" : `Published by ${app.publisherName}`} · listed in {registry.name}
            </span>
          </div>
          <p style={{ margin: "8px 0 0", fontFamily: font, fontSize: 14, color: "var(--app-ink-1)", maxWidth: "62ch" }}>{app.summary}</p>
        </div>
      </header>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
        {action.kind === "none" ? (
          <>
            <Button variant="outline" disabled aria-describedby="detail-reason">
              {action.label}
            </Button>
            <span id="detail-reason" style={{ fontFamily: font, fontSize: 12, color: "var(--app-ink-2)" }}>{action.reason}</span>
          </>
        ) : (
          <Button disabled={busy || paused} aria-busy={busy} onClick={() => onInstall(app)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {busy ? "Installing…" : `${action.label} ${app.name}`}
          </Button>
        )}
      </div>

      <Section id="asks-for" title="What it asks for">
        {scope.length === 0 ? (
          <p style={{ margin: 0, fontFamily: font, fontSize: 13, color: "var(--app-ink-1)" }}>
            It asks for no special access.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 20, listStyle: "disc", fontFamily: font, fontSize: 13, color: "var(--app-ink-1)", display: "grid", gap: 4 }}>
            {scope.map((c, i) => (
              <li key={i}>{capabilityToPlain(c)}</li>
            ))}
          </ul>
        )}
        <p style={{ margin: "10px 0 0", fontFamily: font, fontSize: 12, color: "var(--app-ink-2)", maxWidth: "62ch" }}>
          {REGISTRY_MEANING}
        </p>
      </Section>

      {loading && (
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 28, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)" }}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading details from the registry…
        </div>
      )}

      {error && (
        <div role="alert" style={{ marginTop: 28, padding: "10px 12px", border: "1px solid rgba(210,64,46,.25)", background: "rgba(210,64,46,.06)", borderRadius: 8, fontFamily: font, fontSize: 13, color: "var(--danger-ink)" }}>
          <div>Could not load the details. {error.message}</div>
          {errorHint(error.code) && <div style={{ marginTop: 4, color: "var(--app-ink-2)" }}>{errorHint(error.code)}</div>}
          <Button variant="outline" size="sm" style={{ marginTop: 8 }} onClick={() => load()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {detail && (
        <>
          <Section id="about" title="About">
            <p style={{ margin: 0, fontFamily: font, fontSize: 14, color: "var(--app-ink-1)", maxWidth: "68ch", lineHeight: 1.6 }}>{detail.description}</p>
            <div style={{ display: "grid", gap: 6, marginTop: 12 }}>
              {detail.license && <div style={{ fontFamily: font, fontSize: 12, color: "var(--app-ink-2)" }}>Licence: {detail.license}</div>}
              {detail.homepage && <CopyValue label="Website" value={detail.homepage} />}
              {detail.source && <CopyValue label="Source" value={detail.source} />}
              <div style={{ fontFamily: font, fontSize: 11, color: "var(--app-mute)" }}>Sanctum does not open links itself. Copy one into your browser.</div>
            </div>
          </Section>

          {detail.screenshots.length > 0 && (
            <Section id="screenshots" title="Screenshots">
              <div style={{ display: "grid", gap: 16 }}>
                {detail.screenshots.map((s, i) => (
                  <figure key={i} style={{ margin: 0 }}>
                    {s.dataUrl ? (
                      <img src={s.dataUrl} alt={s.alt} width={s.width} height={s.height} style={{ maxWidth: "100%", height: "auto", border: "1px solid var(--app-border)", borderRadius: 8 }} />
                    ) : (
                      <div role="img" aria-label={`${s.alt} (unavailable)`} style={{ padding: 16, border: "1px dashed var(--app-border)", borderRadius: 8, fontFamily: font, fontSize: 12, color: "var(--app-ink-2)" }}>
                        This screenshot could not be verified, so it is not shown. {s.error}
                      </div>
                    )}
                    <figcaption style={{ marginTop: 4, fontFamily: font, fontSize: 12, color: "var(--app-ink-2)" }}>{s.alt}</figcaption>
                  </figure>
                ))}
              </div>
            </Section>
          )}

          <Section id="whats-new" title="What is new">
            <div style={{ display: "grid", gap: 16 }}>
              {detail.changelog.map((c) => (
                <div key={c.version}>
                  <h3 style={{ margin: "0 0 6px", fontFamily: font, fontSize: 14, fontWeight: 600 }}>
                    {c.version} <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 400, color: "var(--app-ink-2)" }}>{c.date}</span>
                  </h3>
                  <ul style={{ margin: 0, paddingLeft: 20, listStyle: "disc", fontFamily: font, fontSize: 13, color: "var(--app-ink-1)", display: "grid", gap: 3 }}>
                    {c.changes.map((x, i) => (
                      <li key={i}>
                        <strong style={{ color: "var(--app-ink)", fontWeight: 600 }}>{CHANGE_LABEL[x.type]}.</strong> {x.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>

          {detail.manual && (
            <Section id="manual" title="Manual">
              <Markdown source={detail.manual} />
            </Section>
          )}
          {detail.manualError && (
            <Section id="manual" title="Manual">
              <p role="note" style={{ margin: 0, fontFamily: font, fontSize: 13, color: "var(--app-ink-2)" }}>
                The manual could not be verified, so it is not shown. {detail.manualError}
              </p>
            </Section>
          )}
        </>
      )}

      <Section id="versions" title="Versions">
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4, fontFamily: font, fontSize: 13 }}>
          {app.versions.map((v) => (
            <li key={v.version} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
              <span style={{ fontFamily: mono, fontSize: 12 }}>{v.version}</span>
              <span style={{ color: "var(--app-ink-2)" }}>{formatDate(v.publishedAt)}</span>
              {v.version === app.installedVersion && <span>Installed</span>}
              {v.revoked && <span style={{ color: "var(--danger-ink)" }}>Withdrawn by the registry</span>}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
