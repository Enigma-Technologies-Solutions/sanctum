// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, BadgeCheck, Link2, Loader2 } from "lucide-react";
import { Commands } from "@/lib/commands";
import type { LinkEvent, LinkInstallRequest, RegistryCatalogApp, RegistrySummary } from "@/lib/types";
import { actionFor, asRegistryError, errorHint, latestScope } from "@/lib/registry";
import { PermissionBadge } from "@/components/PermissionBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AddRegistryDialog } from "./AddRegistryDialog";

const font = "'Inter', system-ui, sans-serif";
const mono = "'Space Mono', ui-monospace, monospace";

interface Props {
  event: LinkEvent;
  /** Anything was installed or added, so the Tool Vault and Catalogue should reload. */
  onChanged: () => void;
  onOpenVault: () => void;
  onClose: () => void;
  /**
   * How long the buttons that move on stay disabled after the dialog appears. A page can fire
   * links in a loop to swap this dialog just as the user clicks; a short wait means a click
   * can only land on what was already on screen. Tests set it to 0.
   */
  armDelayMs?: number;
}

type Step =
  | { k: "checking" }
  | { k: "refused"; message: string }
  | { k: "needAdd" }
  | { k: "adding" }
  | { k: "confirm"; reg: RegistrySummary; app: RegistryCatalogApp }
  | { k: "notListed"; reg: RegistrySummary; refreshing: boolean }
  | { k: "installing"; reg: RegistrySummary; app: RegistryCatalogApp }
  | { k: "done"; name: string; already: boolean; warnings: string[] }
  | { k: "error"; message: string; hint: string | null; retry: "add" | "install" | null; reg?: RegistrySummary; app?: RegistryCatalogApp };

/**
 * What happens when a sanctum:// link is opened.
 *
 * A link is an invitation. This dialog is the only way it can lead to anything, and it never
 * moves past a step without a click:
 *
 * 1. On arrival it only looks at what is already on this computer (the added registries and
 *    their verified, cached catalogues). No request is made.
 * 2. If the registry is not added yet, the user chooses to add it. For anything but Enigma's
 *    own registry that is the normal "Add a registry" dialog, which shows the signing key.
 * 3. The app is shown with what it asks for. A second click installs it.
 * 4. The install gives the tool no access at all. The user approves each permission later,
 *    on the usual screen.
 *
 * Only the app id and registry address are shown from the link, and both have been validated
 * by Rust. Names and descriptions come from the signed catalogue.
 */
export function LinkInstallDialog({ event, onChanged, onOpenVault, onClose, armDelayMs = 700 }: Props) {
  const [armed, setArmed] = useState(armDelayMs === 0);
  useEffect(() => {
    if (armDelayMs === 0) return;
    const t = setTimeout(() => setArmed(true), armDelayMs);
    return () => clearTimeout(t);
  }, [armDelayMs]);
  const [step, setStep] = useState<Step>(
    event.kind === "refused" ? { k: "refused", message: event.message } : { k: "checking" },
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const request: LinkInstallRequest | null = event.kind === "install" ? event.request : null;

  const show = (s: Step) => {
    if (alive.current) setStep(s);
  };

  /** Find the app in a registry that is already added. Reads the local, verified cache. */
  const lookUp = async (reg: RegistrySummary) => {
    if (!request) return;
    try {
      const cat = await Commands.registryCatalogue(reg.id);
      const app = cat.apps.find((a) => a.appId === request.appId);
      show(app ? { k: "confirm", reg, app } : { k: "notListed", reg, refreshing: false });
    } catch (e) {
      const err = asRegistryError(e);
      show({ k: "error", message: err.message, hint: errorHint(err.code), retry: null });
    }
  };

  // Step 1: look only at what is local.
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    (async () => {
      try {
        const regs = await Commands.listRegistries();
        if (cancelled) return;
        const reg = regs.find((r) => r.baseUrl === request.registryUrl);
        if (reg) await lookUp(reg);
        else show({ k: "needAdd" });
      } catch (e) {
        const err = asRegistryError(e);
        if (!cancelled) show({ k: "error", message: err.message, hint: errorHint(err.code), retry: null });
      }
    })();
    return () => {
      cancelled = true;
    };
    // The request is fixed for the life of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addEnigma = async () => {
    if (!request) return;
    show({ k: "adding" });
    try {
      const reg = await Commands.addRegistry(request.registryUrl);
      onChanged();
      await lookUp(reg);
    } catch (e) {
      const err = asRegistryError(e);
      show({ k: "error", message: err.message, hint: errorHint(err.code), retry: "add" });
    }
  };

  const refreshAndLook = async (reg: RegistrySummary) => {
    show({ k: "notListed", reg, refreshing: true });
    try {
      await Commands.refreshRegistry(reg.id);
      onChanged();
    } catch {
      // The cached catalogue is unchanged: look again at it.
    }
    await lookUp(reg);
  };

  const install = async (reg: RegistrySummary, app: RegistryCatalogApp) => {
    show({ k: "installing", reg, app });
    try {
      const r = await Commands.installFromRegistry(reg.id, app.appId);
      onChanged();
      if (r.state === "installed") {
        show({ k: "done", name: r.install.tool.name, already: false, warnings: [...r.install.warnings, ...r.notes] });
      } else {
        show({ k: "done", name: app.name, already: true, warnings: [] });
      }
    } catch (e) {
      const err = asRegistryError(e);
      show({ k: "error", message: err.message, hint: errorHint(err.code), retry: "install", reg, app });
    }
  };

  const busy = step.k === "adding" || step.k === "installing" || (step.k === "notListed" && step.refreshing);

  // ── Content per step ──────────────────────────────────────────────────────
  let title = "A link wants to open a tool";
  let body: ReactNode = null;
  let actions: ReactNode = null;

  const close = (
    <Button variant="outline" onClick={onClose} disabled={busy}>
      Done
    </Button>
  );
  const cancel = (
    <Button variant="outline" onClick={onClose} disabled={busy}>
      Cancel
    </Button>
  );

  switch (step.k) {
    case "refused":
      title = "Sanctum did not open this link";
      body = <p style={para}>{step.message} Nothing was changed.</p>;
      actions = close;
      break;

    case "checking":
      body = (
        <p role="status" style={para}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" style={{ display: "inline", marginRight: 6 }} />
          Checking what is already on this computer…
        </p>
      );
      actions = cancel;
      break;

    case "needAdd":
      if (request?.isEnigma) {
        title = "Add the Enigma registry?";
        body = (
          <>
            <p style={para}>
              A link asked Sanctum to show <Code>{request.appId}</Code> from the Enigma registry. You have not added
              that registry yet.
            </p>
            <p style={para}>
              Adding it downloads its signed list of tools and checks the signature. Nothing is installed yet: you will
              see the tool and what it asks for first.
            </p>
          </>
        );
        actions = (
          <>
            {cancel}
            <Button onClick={() => void addEnigma()} disabled={!armed}>Add the Enigma registry</Button>
          </>
        );
      } else {
        title = "Add a registry you have not used before?";
        body = (
          <>
            <p style={para}>
              A link asked Sanctum to show <Code>{request?.appId}</Code> from a registry that is not Enigma's. Only
              continue if you know and trust where the link came from.
            </p>
            <div style={label}>Registry address</div>
            <Code block testId="link-registry-url">
              {request?.registryUrl}
            </Code>
            <p style={{ ...para, marginTop: 10 }}>
              Next you will see who signed the registry. Nothing is downloaded or installed until you add it.
            </p>
          </>
        );
        actions = (
          <>
            {cancel}
            <Button onClick={() => setReviewOpen(true)} disabled={!armed}>Review and add…</Button>
          </>
        );
      }
      break;

    case "adding":
      title = "Adding the registry";
      body = (
        <p role="status" style={para}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" style={{ display: "inline", marginRight: 6 }} />
          Downloading and checking the signed list…
        </p>
      );
      actions = cancel;
      break;

    case "confirm": {
      const { reg, app } = step;
      const action = actionFor(app);
      title = action.kind === "none" ? app.name : action.kind === "update" ? `Update ${app.name}?` : `Install ${app.name}?`;
      body = (
        <>
          <p style={{ ...para, marginTop: 0 }}>This request came from a link outside Sanctum. Check you trust where it came from.</p>
          <div style={{ border: "1px solid var(--app-border)", borderRadius: 8, padding: 12, background: "var(--app-surface)" }}>
            <div style={{ fontFamily: "Poppins, system-ui, sans-serif", fontWeight: 700, fontSize: 15 }}>{app.name}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font, fontSize: 12, color: "var(--app-ink-2)", marginTop: 2 }}>
              <BadgeCheck size={13} aria-hidden="true" />
              <span>{app.publisherName}</span>
              <span aria-hidden="true">·</span>
              <span>v{app.latest}</span>
              <span aria-hidden="true">·</span>
              <span>{reg.name}</span>
            </div>
            <p style={{ ...para, margin: "8px 0" }}>{app.summary}</p>
            <div style={label}>Asks for</div>
            <PermissionBadge detected={latestScope(app)} mode="compact" />
          </div>
          {action.kind === "none" ? (
            <p style={{ ...para, marginTop: 12 }}>
              <strong>{action.label}.</strong> {action.reason}
            </p>
          ) : (
            <p style={{ ...para, marginTop: 12 }}>
              Installing adds it with <strong>no access at all</strong>. You approve each permission yourself afterwards.
              The signature shows who published it and that it is unchanged. It does not mean the tool is safe.
            </p>
          )}
        </>
      );
      actions =
        action.kind === "none" ? (
          close
        ) : (
          <>
            {cancel}
            <Button onClick={() => void install(reg, app)} disabled={!armed}>{action.kind === "update" ? action.label : "Install"}</Button>
          </>
        );
      break;
    }

    case "notListed":
      title = "That tool is not in this catalogue";
      body = (
        <p style={para}>
          {step.reg.name} does not list <Code>{request?.appId}</Code> in the catalogue stored on this computer. It may be
          newer than your copy. You can check the registry again, which makes one request to it.
        </p>
      );
      actions = (
        <>
          {close}
          <Button onClick={() => void refreshAndLook(step.reg)} disabled={step.refreshing} aria-busy={step.refreshing}>
            {step.refreshing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {step.refreshing ? "Checking…" : "Check the registry again"}
          </Button>
        </>
      );
      break;

    case "installing":
      title = `Installing ${step.app.name}`;
      body = (
        <p role="status" style={para}>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" style={{ display: "inline", marginRight: 6 }} />
          Downloading and checking the signed bundle…
        </p>
      );
      actions = cancel;
      break;

    case "done":
      title = step.already ? `${step.name} is already installed` : `Installed ${step.name}`;
      body = (
        <>
          <p style={para}>
            {step.already
              ? "This version is already in your Tool Vault."
              : "It has no access yet. Open it in Tool Vault to see what it asks for, and decide."}
          </p>
          {step.warnings.length > 0 && <p style={para}>{step.warnings.join(" ")}</p>}
        </>
      );
      actions = (
        <>
          {close}
          <Button
            onClick={() => {
              onOpenVault();
              onClose();
            }}
          >
            Open Tool Vault
          </Button>
        </>
      );
      break;

    case "error":
      title = "That did not work";
      body = (
        <div role="alert" style={{ ...para, color: "var(--danger-ink)", display: "flex", gap: 8 }}>
          <AlertTriangle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <div>{step.message}</div>
            {step.hint && <div style={{ color: "var(--app-ink-2)", marginTop: 4 }}>{step.hint}</div>}
          </div>
        </div>
      );
      actions = (
        <>
          {close}
          {step.retry === "add" && <Button onClick={() => void addEnigma()}>Try again</Button>}
          {step.retry === "install" && step.reg && step.app && <Button onClick={() => void install(step.reg!, step.app!)}>Try again</Button>}
        </>
      );
      break;
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
        <DialogContent>
          <DialogTitle style={{ fontFamily: "Poppins, system-ui, sans-serif", fontSize: 18, fontWeight: 700, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <Link2 size={18} aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription style={{ fontFamily: font, fontSize: 12, color: "var(--app-ink-2)", margin: "0 0 14px" }}>
            Opened from a sanctum:// link. Nothing happens without your click.
          </DialogDescription>
          {body}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>{actions}</div>
        </DialogContent>
      </Dialog>

      {reviewOpen && request && (
        <AddRegistryDialog
          open
          initialUrl={request.registryUrl}
          onOpenChange={(o) => !o && setReviewOpen(false)}
          onAdded={(reg) => {
            setReviewOpen(false);
            onChanged();
            void lookUp(reg);
          }}
        />
      )}
    </>
  );
}

const para = { fontFamily: font, fontSize: 13, color: "var(--app-ink-1)", margin: "0 0 10px", lineHeight: 1.5 } as const;
const label = { fontFamily: font, fontSize: 11, fontWeight: 600, color: "var(--app-ink-2)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 } as const;

function Code({ children, block, testId }: { children: ReactNode; block?: boolean; testId?: string }) {
  return (
    <code
      data-testid={testId}
      style={{
        fontFamily: mono,
        fontSize: 12,
        wordBreak: "break-all",
        userSelect: "text",
        ...(block ? { display: "block", padding: "8px 10px", border: "1px solid var(--app-border)", borderRadius: 6, background: "var(--app-surface)" } : {}),
      }}
    >
      {children}
    </code>
  );
}
