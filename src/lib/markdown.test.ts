// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { describe, expect, it } from "vitest";
import cases from "../../spec/registry/markdown-cases.json";
import { MarkdownError, parseMarkdown, type Block, type Inline } from "./markdown";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return esc(n.text);
        case "code":
          return `<code>${esc(n.text)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(n.children)}</strong>`;
        case "em":
          return `<em>${inlineHtml(n.children)}</em>`;
        case "link":
          return `<a href="${esc(n.href)}" rel="noopener noreferrer">${esc(n.text)}</a>`;
      }
    })
    .join("");
}

/** The same HTML the Node builder produces, from the parsed tree, so the two can be compared. */
function toHtml(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "heading":
          return `<h${b.level}>${inlineHtml(b.children)}</h${b.level}>`;
        case "p":
          return `<p>${inlineHtml(b.children)}</p>`;
        case "ul":
        case "ol":
          return `<${b.t}>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</${b.t}>`;
        case "quote":
          return `<blockquote><p>${inlineHtml(b.children)}</p></blockquote>`;
        case "pre":
          return `<pre><code>${esc(b.text)}</code></pre>`;
      }
    })
    .join("\n");
}

describe("the manual Markdown subset", () => {
  it("has a substantial shared corpus", () => {
    expect(cases.cases.length).toBeGreaterThanOrEqual(25);
    expect(cases.cases.some((c) => c.ok)).toBe(true);
    expect(cases.cases.some((c) => !c.ok)).toBe(true);
  });

  for (const c of cases.cases) {
    if (c.ok) {
      it(`renders like the Node builder: ${c.name}`, () => {
        expect(toHtml(parseMarkdown(c.src))).toBe(c.html);
      });
    } else {
      it(`refuses, like the Node builder: ${c.name}`, () => {
        expect(() => parseMarkdown(c.src)).toThrow(MarkdownError);
      });
    }
  }

  it("keeps text as data, never as markup", () => {
    const blocks = parseMarkdown('Fish & chips "quoted"');
    expect(blocks).toEqual([{ t: "p", children: [{ t: "text", text: 'Fish & chips "quoted"' }] }]);
  });

  it("only ever produces https links", () => {
    const walk = (nodes: Inline[]): string[] =>
      nodes.flatMap((n) => (n.t === "link" ? [n.href] : "children" in n ? walk(n.children) : []));
    const blocks = parseMarkdown("[a](https://a.test) and *[b](https://b.test/x)*\n\n- [c](https://c.test)");
    const hrefs = blocks.flatMap((b) =>
      b.t === "ul" || b.t === "ol" ? b.items.flatMap(walk) : "children" in b ? walk(b.children) : [],
    );
    expect(hrefs).toEqual(["https://a.test", "https://b.test/x", "https://c.test"]);
  });

  it("reports the line of a problem", () => {
    try {
      parseMarkdown("fine\n\nbad <b>html</b>");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MarkdownError);
      expect((e as MarkdownError).line).toBe(3);
    }
  });
});
