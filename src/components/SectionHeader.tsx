// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import type { ReactNode } from "react";

/**
 * A titled block inside a page: name, one line of facts under it, actions on the right.
 * The Catalogue uses it for a registry, the Tool Vault for a publisher.
 */
export function SectionHeader({
  id,
  title,
  meta,
  actions,
}: {
  id: string;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div>
        <h2 id={id} style={{ margin: 0, fontFamily: "Poppins, system-ui, sans-serif", fontSize: 16, fontWeight: 700, color: "var(--app-ink)" }}>
          {title}
        </h2>
        {meta && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, color: "var(--app-ink-2)", marginTop: 2 }}>
            {meta}
          </div>
        )}
      </div>
      {actions && <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
    </div>
  );
}

export function Dot() {
  return <span aria-hidden="true">·</span>;
}
