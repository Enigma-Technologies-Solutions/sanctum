// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/**
 * Renders a registry manual. The text is untrusted: it is parsed by a strict subset parser
 * and turned into React elements, never into an HTML string, so nothing in it can become
 * markup. Anything outside the subset is shown as plain text instead.
 *
 * Links do not navigate. Sanctum does not open links itself, so a link shows its text, its
 * address, and a button that copies the address.
 */

const font = "'Inter', system-ui, sans-serif";
const mono = "'Space Mono', ui-monospace, monospace";

function CopyLink({ href, label }: { href: string; label: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      aria-label={`Copy link: ${label}`}
      onClick={async () => {
        try {
          await writeText(href);
          setState("done");
        } catch {
          setState("failed");
        }
        setTimeout(() => setState("idle"), 1800);
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        marginLeft: 6,
        padding: "0 6px",
        background: "#F7F8FA",
        border: "1px solid #E3E7EC",
        borderRadius: 4,
        fontFamily: font,
        fontSize: 11,
        color: "#0A0A0A",
        cursor: "pointer",
        verticalAlign: "baseline",
      }}
    >
      {state === "done" ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      {state === "done" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.text;
      case "code":
        return (
          <code key={i} style={{ fontFamily: mono, fontSize: "0.9em", background: "#F7F8FA", border: "1px solid #E3E7EC", borderRadius: 4, padding: "0 4px" }}>
            {n.text}
          </code>
        );
      case "strong":
        return <strong key={i} style={{ color: "#0A0A0A" }}>{renderInline(n.children)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "link":
        return (
          <span key={i}>
            <span style={{ textDecoration: "underline", textUnderlineOffset: 3, color: "#0A0A0A" }}>{n.text}</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "#6B717A" }}> ({n.href})</span>
            <CopyLink href={n.href} label={n.text} />
          </span>
        );
    }
  });
}

function renderBlock(b: Block, i: number): ReactNode {
  const heading = { fontFamily: "Poppins, system-ui, sans-serif", color: "#0A0A0A", margin: "20px 0 6px", letterSpacing: "-0.01em" } as const;
  switch (b.t) {
    case "heading": {
      // h1 is the app name and h2 the section, so manual headings start at h3.
      const Tag = `h${Math.min(b.level, 6)}` as "h3" | "h4" | "h5" | "h6";
      return <Tag key={i} style={{ ...heading, fontSize: b.level <= 3 ? 17 : 15 }}>{renderInline(b.children)}</Tag>;
    }
    case "p":
      return <p key={i} style={{ margin: "0 0 10px" }}>{renderInline(b.children)}</p>;
    case "ul":
      return (
        <ul key={i} style={{ margin: "0 0 10px", paddingLeft: 22, listStyle: "disc" }}>
          {b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{renderInline(it)}</li>)}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} style={{ margin: "0 0 10px", paddingLeft: 22, listStyle: "decimal" }}>
          {b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{renderInline(it)}</li>)}
        </ol>
      );
    case "quote":
      return (
        <blockquote key={i} style={{ margin: "0 0 10px", paddingLeft: 14, borderLeft: "2px solid #E3E7EC" }}>
          {renderInline(b.children)}
        </blockquote>
      );
    case "pre":
      return (
        <pre key={i} style={{ margin: "0 0 10px", padding: "10px 12px", background: "#F7F8FA", border: "1px solid #E3E7EC", borderRadius: 6, overflowX: "auto", fontFamily: mono, fontSize: 12 }}>
          <code>{b.text}</code>
        </pre>
      );
  }
}

export function Markdown({ source }: { source: string }) {
  const parsed = useMemo(() => {
    try {
      return { blocks: parseMarkdown(source), error: null as string | null };
    } catch (e) {
      return { blocks: null, error: e instanceof Error ? e.message : "unreadable" };
    }
  }, [source]);

  const base = { fontFamily: font, fontSize: 14, lineHeight: 1.65, color: "#3A4048", maxWidth: "68ch" } as const;

  if (!parsed.blocks) {
    // Outside the subset: show it as it is, as text. Nothing is interpreted.
    return (
      <div style={base}>
        <p role="note" style={{ margin: "0 0 8px", fontSize: 12, color: "#6B717A" }}>
          This manual could not be formatted, so it is shown as plain text.
        </p>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: mono, fontSize: 12 }}>{source}</pre>
      </div>
    );
  }
  return <div style={base}>{parsed.blocks.map(renderBlock)}</div>;
}
