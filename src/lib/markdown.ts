// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

/**
 * The Markdown subset allowed in a registry manual (docs/registry-format.md, "Manual
 * Markdown"). The registry builder checks the same rules, so a manual that reaches the app
 * should always parse; the app still treats it as untrusted. Anything outside the subset is an
 * error, and the caller shows the text as plain text instead of guessing.
 *
 * Allowed: headings (# to ####), paragraphs, **strong**, *emphasis*, `code`, fenced code,
 * bullet and numbered lists (one level), block quotes, and [text](https://...) links.
 * Not allowed: raw HTML, images, other link schemes, nested lists, tables.
 *
 * This module only parses. It produces a tree of plain data; rendering it as React elements
 * (never as HTML strings) is in components/catalogue/Markdown.tsx. It must give the same
 * verdict, and the same structure, as scripts/lib/markdown.mjs: both are tested against
 * spec/registry/markdown-cases.json.
 */

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "link"; href: string; text: string };

export type Block =
  | { t: "heading"; level: number; children: Inline[] }
  | { t: "p"; children: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "quote"; children: Inline[] }
  | { t: "pre"; text: string };

export class MarkdownError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`manual line ${line}: ${message}`);
    this.name = "MarkdownError";
    this.line = line;
  }
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]*\))/g;
const LINK =
  /^\[([^\]]+)\]\((https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/?=&#+:@!$'*,;-]*)?)\)$/;

function plain(s: string, line: number): Inline[] {
  if (/<[A-Za-z/!?]/.test(s)) throw new MarkdownError("raw HTML is not allowed", line);
  if (s.includes("![")) throw new MarkdownError("images are not allowed in a manual", line);
  if (/\]\(/.test(s)) throw new MarkdownError("link must be [text](https://...)", line);
  return s === "" ? [] : [{ t: "text", text: s }];
}

function inline(text: string, line: number): Inline[] {
  // An image is a link with a bang in front; the link syntax alone would hide it.
  if (text.replace(/`[^`\n]*`/g, "").includes("![")) {
    throw new MarkdownError("images are not allowed in a manual", line);
  }
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const index = m.index ?? 0;
    out.push(...plain(text.slice(last, index), line));
    const tok = m[0];
    if (m[1]) out.push({ t: "code", text: tok.slice(1, -1) });
    else if (m[2]) out.push({ t: "strong", children: inline(tok.slice(2, -2), line) });
    else if (m[3]) out.push({ t: "em", children: inline(tok.slice(1, -1), line) });
    else {
      const link = LINK.exec(tok);
      if (!link) throw new MarkdownError(`link must be [text](https://...): ${tok}`, line);
      out.push({ t: "link", href: link[2], text: link[1] });
    }
    last = index + tok.length;
  }
  out.push(...plain(text.slice(last), line));
  return out;
}

/** Parse a manual. Throws MarkdownError on anything outside the subset. */
export function parseMarkdown(src: string): Block[] {
  if (src.includes("\r")) throw new MarkdownError("use LF line endings", 1);
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  let para: { text: string; n: number }[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ t: "p", children: inline(para.map((p) => p.text).join(" "), para[0].n) });
      para = [];
    }
  };
  while (i < lines.length) {
    const raw = lines[i];
    const n = i + 1;
    if (/^```/.test(raw)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) throw new MarkdownError("code fence is not closed", n);
      i++;
      blocks.push({ t: "pre", text: body.join("\n") });
      continue;
    }
    if (raw.trim() === "") {
      flush();
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.+?)\s*$/.exec(raw);
    if (h) {
      flush();
      blocks.push({ t: "heading", level: h[1].length + 2, children: inline(h[2], n) });
      i++;
      continue;
    }
    if (/^\s+([-*]|\d+\.)\s/.test(raw)) throw new MarkdownError("nested lists are not allowed", n);
    const ul = /^[-*]\s+(.*)$/.exec(raw);
    const ol = /^\d+\.\s+(.*)$/.exec(raw);
    if (ul || ol) {
      flush();
      const re = ul ? /^[-*]\s+(.*)$/ : /^\d+\.\s+(.*)$/;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(inline((re.exec(lines[i]) as RegExpExecArray)[1], i + 1));
        i++;
      }
      blocks.push({ t: ul ? "ul" : "ol", items });
      continue;
    }
    if (/^>\s?/.test(raw)) {
      flush();
      const quote: string[] = [];
      const first = n;
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ t: "quote", children: inline(quote.join(" ").trim(), first) });
      continue;
    }
    if (/^\|/.test(raw)) throw new MarkdownError("tables are not allowed", n);
    para.push({ text: raw.trim(), n });
    i++;
  }
  flush();
  return blocks;
}
