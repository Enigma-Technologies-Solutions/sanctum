// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, BadgeCheck, Download, Loader2, Plus, RefreshCw, Store, Trash2 } from "lucide-react";
import { Commands } from "@/lib/commands";
import type { RegistryBatchItem, RegistryCatalogApp, RegistryCatalogue, RegistrySummary } from "@/lib/types";
import {
  asRegistryError,
  ENIGMA_REGISTRY_URL,
  errorHint,
  formatDate,
  REGISTRY_MEANING,
  trustLabel,
} from "@/lib/registry";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AddRegistryDialog } from "./AddRegistryDialog";
import { AppCard } from "./AppCard";
import { AppDetail } from "./AppDetail";

const font = "'Inter', system-ui, sans-serif";

type Notice = { kind: "success" | "info" | "error"; text: string; hint?: string | null };

interface Props {
  /** Called after anything was installed, so the Tool Vault can reload. */
  onLibraryChanged: () => void;
  onOpenVault: () => void;
}

function Banner({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  const warn = tone === "warn";
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "8px 12px",
        background: warn ? "#FFF8E1" : "rgba(210,64,46,.06)",
        border: `1px solid ${warn ? "#F0DFA0" : "rgba(210,64,46,.25)"}`,
        borderRadius: 8,
        fontFamily: font,
        fontSize: 12.5,
        color: warn ? "#5A4A10" : "var(--danger-ink)",
      }}
    >
      <AlertTriangle size={14} aria-hidden="true" style={{ marginTop: 2, flexShrink: 0 }} />
      <div>{children}</div>
    </div>
  );
}

export function CatalogueView({ onLibraryChanged, onOpenVault }: Props) {
  const [registries, setRegistries] = useState<RegistrySummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<RegistryCatalogue | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openApp, setOpenApp] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addingEnigma, setAddingEnigma] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null); // app id, or "*" for all
  const [removeOpen, setRemoveOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [batch, setBatch] = useState<RegistryBatchItem[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const selected = registries?.find((r) => r.id === selectedId) ?? null;

  const loadCatalogue = useCallback(async (id: string) => {
    try {
      setCatalogue(await Commands.registryCatalogue(id));
      setLoadError(null);
    } catch (e) {
      setCatalogue(null);
      setLoadError(asRegistryError(e).message);
    }
  }, []);

  const loadRegistries = useCallback(
    async (prefer?: string) => {
      try {
        const list = await Commands.listRegistries();
        setRegistries(list);
        const next = list.find((r) => r.id === prefer) ?? list.find((r) => r.id === selectedId) ?? list[0] ?? null;
        setSelectedId(next?.id ?? null);
        if (next) await loadCatalogue(next.id);
        else setCatalogue(null);
      } catch (e) {
        setRegistries([]);
        setLoadError(asRegistryError(e).message);
      }
    },
    [loadCatalogue, selectedId],
  );

  useEffect(() => {
    void loadRegistries();
    // Only on first show: later reloads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const afterAdd = async (r: RegistrySummary) => {
    setNotice({ kind: "success", text: `Added ${r.name}. Nothing is installed yet.` });
    await loadRegistries(r.id);
  };

  const addEnigma = async () => {
    setAddingEnigma(true);
    setNotice(null);
    try {
      await afterAdd(await Commands.addRegistry(ENIGMA_REGISTRY_URL));
    } catch (e) {
      const err = asRegistryError(e);
      setNotice({ kind: "error", text: err.message, hint: errorHint(err.code) });
    } finally {
      setAddingEnigma(false);
    }
  };

  const refresh = async () => {
    if (!selected) return;
    setRefreshing(true);
    setNotice(null);
    try {
      const r = await Commands.refreshRegistry(selected.id);
      const index =
        r.index.state === "updated" ? `Updated to catalogue ${r.index.toSerial}.` : "The catalogue is already up to date.";
      const rev = r.revocations.state === "failed" ? ` ${r.revocations.message}` : "";
      setNotice({ kind: r.revocations.state === "failed" ? "error" : "success", text: index + rev });
      await loadRegistries(selected.id);
    } catch (e) {
      const err = asRegistryError(e);
      setNotice({ kind: "error", text: err.message, hint: errorHint(err.code) });
      await loadRegistries(selected.id); // shows the recorded error, and the unchanged cache
    } finally {
      setRefreshing(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    try {
      await Commands.removeRegistry(selected.id);
      setRemoveOpen(false);
      setOpenApp(null);
      setNotice({ kind: "info", text: `Removed ${selected.name}. Tools you installed from it stay in your vault.` });
      setSelectedId(null);
      await loadRegistries();
    } catch (e) {
      setRemoveOpen(false);
      setNotice({ kind: "error", text: asRegistryError(e).message });
    }
  };

  const install = async (app: RegistryCatalogApp) => {
    if (!selected || installing) return;
    setInstalling(app.appId);
    setNotice(null);
    try {
      const r = await Commands.installFromRegistry(selected.id, app.appId);
      if (r.state === "installed") {
        const warnings = [...r.install.warnings, ...r.notes];
        setNotice({
          kind: "success",
          text: `Installed ${r.install.tool.name}. It has no access yet: open it in Tool Vault to see what it asks for and decide.${warnings.length ? " " + warnings.join(" ") : ""}`,
        });
        onLibraryChanged();
      } else {
        setNotice({ kind: "info", text: `${app.name} ${r.version} is already installed.` });
      }
      await loadCatalogue(selected.id);
    } catch (e) {
      const err = asRegistryError(e);
      setNotice({ kind: "error", text: err.message, hint: errorHint(err.code) });
    } finally {
      setInstalling(null);
    }
  };

  const installAll = async () => {
    if (!selected) return;
    setAllOpen(false);
    setInstalling("*");
    setNotice(null);
    setBatch(null);
    try {
      const items = await Commands.installAllFromRegistry(selected.id);
      setBatch(items);
      if (items.some((i) => i.state === "installed")) onLibraryChanged();
      await loadCatalogue(selected.id);
    } catch (e) {
      const err = asRegistryError(e);
      setNotice({ kind: "error", text: err.message, hint: errorHint(err.code) });
    } finally {
      setInstalling(null);
    }
  };

  // What "Install all" will actually try: not licensed, not already current, not withdrawn.
  const installable =
    catalogue?.apps.filter((a) => (a.state === "notInstalled" || a.state === "updateAvailable") && !a.latestRevoked) ?? [];
  const detailApp = openApp ? catalogue?.apps.find((a) => a.appId === openApp) ?? null : null;

  // ── Loading ───────────────────────────────────────────────────────────────
  if (registries === null) {
    return (
      <div role="status" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, height: "100%", fontFamily: font, fontSize: 13, color: "var(--app-mute)" }}>
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading catalogue…
      </div>
    );
  }

  // ── Detail ────────────────────────────────────────────────────────────────
  if (selected && detailApp) {
    return (
      <div style={{ height: "100%", overflowY: "auto" }}>
        <div role="status" aria-live="polite" style={{ padding: notice ? "12px 24px 0" : 0 }}>
          {notice && <NoticeView notice={notice} onOpenVault={onOpenVault} />}
        </div>
        <AppDetail
          registry={selected}
          app={detailApp}
          busy={installing === detailApp.appId}
          paused={installing !== null}
          onBack={() => setOpenApp(null)}
          onInstall={install}
        />
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--app-border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div className="volt-bar" style={{ width: 32 }} />
          <span style={{ fontFamily: font, fontSize: 11, fontWeight: 600, color: "var(--app-mute)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Catalogue
          </span>
        </div>
        <h1 style={{ fontFamily: "Poppins, system-ui, sans-serif", fontWeight: 700, fontSize: 20, margin: "0 0 4px", letterSpacing: "-0.01em" }}>
          Find tools
        </h1>
        <div className="volt-bar" style={{ width: 48, marginBottom: 12 }} />
        <p style={{ margin: 0, fontFamily: font, fontSize: 12.5, color: "var(--app-ink-2)", maxWidth: "70ch" }}>{REGISTRY_MEANING}</p>
      </div>

      <div style={{ padding: "16px 24px 40px", display: "grid", gap: 14 }}>
        <div role="status" aria-live="polite">
          {notice && <NoticeView notice={notice} onOpenVault={onOpenVault} />}
        </div>

        {registries.length === 0 ? (
          <section
            aria-labelledby="empty-title"
            style={{ padding: 24, border: "1px solid var(--app-border)", borderRadius: 10, background: "var(--app-bg)" }}
          >
            <Store size={22} aria-hidden="true" />
            <h2 id="empty-title" style={{ margin: "10px 0 6px", fontFamily: "Poppins, system-ui, sans-serif", fontSize: 17, fontWeight: 700 }}>
              No registry yet
            </h2>
            <p style={{ margin: "0 0 16px", fontFamily: font, fontSize: 13, color: "var(--app-ink-1)", maxWidth: "62ch" }}>
              Add the Enigma registry to browse tools signed by Enigma Technologies Solutions. You will
              see what each tool asks for before you install it, and nothing runs with access until you
              approve it.
            </p>
            {loadError && <div role="alert" style={{ marginBottom: 12, fontFamily: font, fontSize: 12, color: "var(--danger-ink)" }}>{loadError}</div>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button variant="volt" onClick={() => void addEnigma()} disabled={addingEnigma} aria-busy={addingEnigma}>
                {addingEnigma && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {addingEnigma ? "Adding…" : "Add the Enigma registry"}
              </Button>
              <Button variant="outline" onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                Add another registry
              </Button>
            </div>
          </section>
        ) : (
          <>
            {registries.length > 1 && (
              <div role="tablist" aria-label="Registries" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {registries.map((r) => (
                  <button
                    key={r.id}
                    role="tab"
                    type="button"
                    aria-selected={r.id === selectedId}
                    onClick={() => {
                      setSelectedId(r.id);
                      setOpenApp(null);
                      setBatch(null);
                      void loadCatalogue(r.id);
                    }}
                    style={{
                      padding: "6px 12px",
                      border: "1px solid var(--app-border)",
                      borderRadius: 6,
                      background: r.id === selectedId ? "var(--app-ink)" : "var(--app-bg)",
                      color: r.id === selectedId ? "var(--app-bg)" : "var(--app-ink)",
                      fontFamily: font,
                      fontSize: 12.5,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            )}

            {selected && (
              <section aria-labelledby="registry-name" style={{ display: "grid", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <h2 id="registry-name" style={{ margin: 0, fontFamily: "Poppins, system-ui, sans-serif", fontSize: 16, fontWeight: 700 }}>
                      {selected.name}
                    </h2>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font, fontSize: 12, color: "var(--app-ink-2)", marginTop: 2 }}>
                      <BadgeCheck size={13} aria-hidden="true" />
                      <span>{trustLabel(selected)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{selected.appCount} {selected.appCount === 1 ? "tool" : "tools"}</span>
                      <span aria-hidden="true">·</span>
                      <span>Catalogue {selected.serial}</span>
                      {selected.lastCheckedAt && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>Checked {formatDate(selected.lastCheckedAt)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing}>
                      {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                      {refreshing ? "Checking…" : "Refresh"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      Add registry
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoveOpen(true)} aria-label={`Remove ${selected.name}`}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Remove
                    </Button>
                  </div>
                </div>

                {selected.stale && (
                  <Banner tone="warn">
                    This catalogue expired on {formatDate(selected.expires)}. You can still browse and install from it, but newer
                    versions or withdrawals may be missing. Refresh to check.
                  </Banner>
                )}
                {selected.revocations?.stale && (
                  <Banner tone="warn">
                    The list of withdrawn tools is out of date, so a recent withdrawal may not be known here yet. Refresh to check.
                  </Banner>
                )}
                {selected.lastError && <Banner tone="error">The last check failed: {selected.lastError} The catalogue below is unchanged.</Banner>}
                {loadError && <Banner tone="error">{loadError}</Banner>}

                {installable.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <Button variant="secondary" size="sm" onClick={() => setAllOpen(true)} disabled={installing !== null}>
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      Install all ({installable.length})
                    </Button>
                    <span style={{ fontFamily: font, fontSize: 12, color: "var(--app-ink-2)" }}>
                      Installing adds tools with no access. You approve each permission afterwards.
                    </span>
                  </div>
                )}
              </section>
            )}

            {batch && <BatchResults items={batch} onOpenVault={onOpenVault} />}

            {catalogue && (
              <div
                role="list"
                aria-label={`Tools in ${catalogue.registryName}`}
                style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}
              >
                {catalogue.apps.map((a) => (
                  <div role="listitem" key={a.appId} style={{ display: "contents" }}>
                    <AppCard
                      app={a}
                      busy={installing === a.appId || installing === "*"}
                      paused={installing !== null}
                      onInstall={install}
                      onOpen={(x) => setOpenApp(x.appId)}
                    />
                  </div>
                ))}
                {catalogue.apps.length === 0 && (
                  <p style={{ fontFamily: font, fontSize: 13, color: "var(--app-ink-2)" }}>This registry does not list any tools yet.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <AddRegistryDialog open={addOpen} onOpenChange={setAddOpen} onAdded={(r) => void afterAdd(r)} />

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogTitle style={{ fontFamily: "Poppins, system-ui, sans-serif", fontSize: 18, fontWeight: 700, margin: "0 0 6px" }}>
            Remove {selected?.name}?
          </DialogTitle>
          <DialogDescription style={{ fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", margin: "0 0 16px" }}>
            Sanctum forgets this registry and its catalogue. Tools you already installed from it stay in
            your vault, with their approvals. You can add the registry again later.
          </DialogDescription>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void remove()}>Remove registry</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={allOpen} onOpenChange={setAllOpen}>
        <DialogContent>
          <DialogTitle style={{ fontFamily: "Poppins, system-ui, sans-serif", fontSize: 18, fontWeight: 700, margin: "0 0 6px" }}>
            Install {installable.length} {installable.length === 1 ? "tool" : "tools"}?
          </DialogTitle>
          <DialogDescription style={{ fontFamily: font, fontSize: 13, color: "var(--app-ink-2)", margin: "0 0 12px" }}>
            Each is checked against the registry's signed list before it is added. None of them gets any
            access: you approve each permission yourself, tool by tool, in Tool Vault.
          </DialogDescription>
          <ul style={{ margin: "0 0 16px", paddingLeft: 20, listStyle: "disc", fontFamily: font, fontSize: 13 }}>
            {installable.map((a) => (
              <li key={a.appId}>
                {a.name} v{a.latest}
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button variant="outline" onClick={() => setAllOpen(false)}>Cancel</Button>
            <Button onClick={() => void installAll()}>Install all</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NoticeView({ notice, onOpenVault }: { notice: Notice; onOpenVault: () => void }) {
  const error = notice.kind === "error";
  return (
    <div
      role={error ? "alert" : undefined}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${error ? "rgba(210,64,46,.25)" : "var(--app-border)"}`,
        background: error ? "rgba(210,64,46,.06)" : notice.kind === "success" ? "rgba(30,158,98,.08)" : "var(--app-surface)",
        fontFamily: font,
        fontSize: 13,
        color: error ? "var(--danger-ink)" : "var(--app-ink)",
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <div>{notice.text}</div>
        {notice.hint && <div style={{ marginTop: 3, color: "var(--app-ink-2)", fontSize: 12 }}>{notice.hint}</div>}
      </div>
      {notice.kind === "success" && notice.text.startsWith("Installed ") && (
        <Button variant="outline" size="sm" onClick={onOpenVault}>
          Open Tool Vault
        </Button>
      )}
    </div>
  );
}

function BatchResults({ items, onOpenVault }: { items: RegistryBatchItem[]; onOpenVault: () => void }) {
  const done = items.filter((i) => i.state === "installed").length;
  return (
    <section aria-labelledby="batch-title" style={{ padding: 14, border: "1px solid var(--app-border)", borderRadius: 10, background: "var(--app-surface)" }}>
      <h3 id="batch-title" style={{ margin: "0 0 6px", fontFamily: font, fontSize: 14, fontWeight: 600 }}>
        {done} installed, none approved
      </h3>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 3, fontFamily: font, fontSize: 13 }}>
        {items.map((i) => (
          <li key={i.appId}>
            <strong style={{ fontWeight: 600 }}>{i.name}</strong>:{" "}
            {i.state === "installed"
              ? `installed v${i.version}, no access yet`
              : i.state === "alreadyInstalled"
                ? `already installed (v${i.version})`
                : `not installed. ${i.message}`}
          </li>
        ))}
      </ul>
      {done > 0 && (
        <Button variant="outline" size="sm" style={{ marginTop: 10 }} onClick={onOpenVault}>
          Open Tool Vault to review what they ask for
        </Button>
      )}
    </section>
  );
}
