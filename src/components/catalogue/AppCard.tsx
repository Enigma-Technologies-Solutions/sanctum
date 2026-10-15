// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { BadgeCheck, Loader2, Package } from "lucide-react";
import type { RegistryCatalogApp } from "@/lib/types";
import { actionFor, latestScope } from "@/lib/registry";
import { PermissionBadge } from "@/components/PermissionBadge";
import { Button } from "@/components/ui/button";

const font = "'Inter', system-ui, sans-serif";

interface Props {
  app: RegistryCatalogApp;
  /** An install of this app is running. */
  busy: boolean;
  /** Another install is running, so actions are paused. */
  paused: boolean;
  onInstall: (app: RegistryCatalogApp) => void;
  onOpen: (app: RegistryCatalogApp) => void;
}

/**
 * One app in the catalogue. The scope is shown before anything is installed, and the state is
 * written out in words, never colour alone.
 */
export function AppCard({ app, busy, paused, onInstall, onOpen }: Props) {
  const action = actionFor(app);
  const nameId = `app-${app.appId}-name`;
  const reasonId = `app-${app.appId}-reason`;
  return (
    <article
      aria-labelledby={nameId}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 16,
        background: "#FFFFFF",
        border: "1px solid #E3E7EC",
        borderRadius: 10,
        minHeight: 168,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          aria-hidden="true"
          style={{ display: "inline-flex", width: 36, height: 36, alignItems: "center", justifyContent: "center", background: "#F7F8FA", border: "1px solid #E3E7EC", borderRadius: 8, flexShrink: 0 }}
        >
          <Package size={18} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h3 id={nameId} style={{ margin: 0, fontFamily: "Poppins, system-ui, sans-serif", fontSize: 15, fontWeight: 700, letterSpacing: "-0.01em" }}>
            <button
              type="button"
              onClick={() => onOpen(app)}
              style={{ all: "unset", cursor: "pointer", textDecoration: "underline", textDecorationColor: "#E3E7EC", textUnderlineOffset: 4 }}
              aria-label={`Details for ${app.name}`}
            >
              {app.name}
            </button>
          </h3>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font, fontSize: 12, color: "#565B62", marginTop: 2 }}>
            <BadgeCheck size={13} aria-hidden="true" />
            <span>{app.publisherName}</span>
            <span aria-hidden="true">·</span>
            <span>v{app.latest}</span>
          </div>
        </div>
      </div>

      <p style={{ margin: 0, fontFamily: font, fontSize: 13, color: "#3A4048", flex: 1 }}>{app.summary}</p>

      <div>
        <div style={{ fontFamily: font, fontSize: 10.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B717A", marginBottom: 4 }}>
          Asks for
        </div>
        <PermissionBadge detected={latestScope(app)} mode="compact" />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {action.kind === "none" ? (
          <>
            <Button variant="outline" size="sm" disabled aria-describedby={reasonId}>
              {action.label}
            </Button>
            <span id={reasonId} style={{ fontFamily: font, fontSize: 11.5, color: "#565B62" }}>
              {action.reason}
            </span>
          </>
        ) : (
          <Button
            size="sm"
            disabled={busy || paused}
            aria-busy={busy}
            aria-label={`${action.label} ${app.name}`}
            onClick={() => onInstall(app)}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {busy ? "Installing…" : action.label}
          </Button>
        )}
      </div>
    </article>
  );
}
