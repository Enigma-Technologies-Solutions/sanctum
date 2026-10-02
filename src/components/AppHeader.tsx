// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { Library as LibraryIcon, Settings as SettingsIcon } from "lucide-react";

export type View = "vault" | "settings";

const NAV: { id: View; label: string; Icon: typeof LibraryIcon }[] = [
  { id: "vault", label: "Tool Vault", Icon: LibraryIcon },
  { id: "settings", label: "Settings", Icon: SettingsIcon },
];

/** ETS badge: black tile, border-radius 0 always, with the ENIGMA wordmark. */
function ETSMark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
      <span
        className="ets-tile"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0A0A0A",
          width: "42px",
          height: "28px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: "'Inter', 'Helvetica Neue', Arial, sans-serif",
            fontWeight: 800,
            fontSize: "13px",
            color: "#FFFFFF",
            letterSpacing: "0.01em",
            lineHeight: 1,
            userSelect: "none",
          }}
        >
          ETS
        </span>
      </span>
      <span
        style={{
          fontFamily: "'Space Mono', ui-monospace, monospace",
          fontSize: "11px",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#0A0A0A",
          userSelect: "none",
        }}
      >
        Enigma
      </span>
    </div>
  );
}

const divider = <div aria-hidden="true" style={{ width: "1px", height: "12px", background: "#E3E7EC" }} />;

export function AppHeader({
  view,
  onNavigate,
  version,
}: {
  view: View;
  onNavigate: (v: View) => void;
  version: string | null;
}) {
  return (
    <header
      style={{
        background: "#FFFFFF",
        borderBottom: "1px solid #E3E7EC",
        display: "flex",
        alignItems: "stretch",
        height: "52px",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", padding: "0 20px", borderRight: "1px solid #E3E7EC", flexShrink: 0 }}>
        <ETSMark />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "0 20px", borderRight: "1px solid #E3E7EC", flexShrink: 0 }}>
        <div style={{ width: "3px", height: "20px", background: "#FBFF00", flexShrink: 0 }} />
        <div
          style={{
            fontFamily: "Poppins, system-ui, sans-serif",
            fontWeight: 700,
            fontSize: "14px",
            color: "#0A0A0A",
            letterSpacing: "-0.01em",
          }}
        >
          Sanctum
        </div>
      </div>

      <nav aria-label="Main" style={{ display: "flex", alignItems: "stretch", paddingLeft: "8px" }}>
        {NAV.map(({ id, label, Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
             
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate(id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "7px",
                padding: "0 14px",
                background: "transparent",
                border: "none",
                // Volt marks the active tab as a fill bar, not as text colour.
                borderBottom: `3px solid ${active ? "#FBFF00" : "transparent"}`,
                borderRadius: 0,
                marginBottom: "-1px",
                color: active ? "#0A0A0A" : "#565B62",
                fontFamily: "'Inter', system-ui, sans-serif",
                fontSize: "13px",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
              }}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 20px",
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: "12px",
          color: "#6B717A",
        }}
      >
        {version && (
          <>
            <span>v{version}</span>
            {divider}
          </>
        )}
        <span>Tools run sandboxed</span>
      </div>
    </header>
  );
}
