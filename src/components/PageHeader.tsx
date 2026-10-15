// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import type { ReactNode } from "react";

/**
 * The header every tab shares: title, volt bar, one short description. It keeps the same
 * height on every tab (room for three lines of description), so switching tabs never moves
 * the content below it. Controls belong in the page body, not here.
 */
export function PageHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header
      style={{
        flexShrink: 0,
        padding: "20px 24px 16px",
        borderBottom: "1px solid var(--app-border)",
        background: "var(--app-bg)",
      }}
    >
      <h1
        style={{
          fontFamily: "Poppins, system-ui, sans-serif",
          fontWeight: 700,
          fontSize: 20,
          lineHeight: "30px",
          margin: "0 0 4px",
          letterSpacing: "-0.01em",
          color: "var(--app-ink)",
        }}
      >
        {title}
      </h1>
      <div className="volt-bar" style={{ width: 48, marginBottom: 12 }} />
      <p
        style={{
          margin: 0,
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 12.5,
          lineHeight: "19px",
          minHeight: 57,
          color: "var(--app-ink-2)",
          maxWidth: "70ch",
        }}
      >
        {children}
      </p>
    </header>
  );
}
