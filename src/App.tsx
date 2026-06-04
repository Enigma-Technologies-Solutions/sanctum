// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { Library } from "@/components/Library";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * ETS badge — primary logo mark on light surfaces.
 * Black landscape tile (≈3:2, border-radius 0 always), white "ETS" in Inter 800.
 * Paired with "ENIGMA" wordmark in Space Mono (brand identifier, not UI text).
 */
function ETSMark() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
      {/* Black tile — hard-edged, never rounded */}
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
      {/* Wordmark — Space Mono is correct here (brand identifier) */}
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

function AppHeader() {
  return (
    <header
      style={{
        background: "#FFFFFF",
        borderBottom: "1px solid #E3E7EC",
        display: "flex",
        alignItems: "center",
        height: "52px",
        flexShrink: 0,
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      {/* ETS brand mark */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          height: "100%",
          borderRight: "1px solid #E3E7EC",
          flexShrink: 0,
        }}
      >
        <ETSMark />
      </div>

      {/* App name */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "0 20px",
          height: "100%",
          borderRight: "1px solid #E3E7EC",
          flexShrink: 0,
        }}
      >
        {/* Volt accent bar — kept sharp (no radius), brand signal */}
        <div style={{ width: "3px", height: "20px", background: "#FBFF00", flexShrink: 0 }} />
        <div>
          <div
            style={{
              fontFamily: "Poppins, system-ui, sans-serif",
              fontWeight: 700,
              fontSize: "14px",
              color: "#0A0A0A",
              letterSpacing: "-0.01em",
              lineHeight: 1.1,
            }}
          >
            Sanctum
          </div>
          <div
            style={{
              fontFamily: "'Inter', system-ui, sans-serif",
              fontSize: "11px",
              color: "#8A9099",
              lineHeight: 1,
              marginTop: "2px",
            }}
          >
            Tool Vault
          </div>
        </div>
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Status — Inter, muted */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "0 20px",
          fontFamily: "'Inter', system-ui, sans-serif",
          fontSize: "12px",
          color: "#8A9099",
        }}
      >
        <span>v0</span>
        <div style={{ width: "1px", height: "12px", background: "#E3E7EC" }} />
        <span>Offline</span>
        <div style={{ width: "1px", height: "12px", background: "#E3E7EC" }} />
        <span>Sandbox active</span>
      </div>
    </header>
  );
}

function App() {
  return (
    <TooltipProvider delayDuration={400}>
      <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "#FFFFFF", overflow: "hidden" }}>
        <AppHeader />
        <main style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          <Library />
        </main>
      </div>
    </TooltipProvider>
  );
}

export default App;
