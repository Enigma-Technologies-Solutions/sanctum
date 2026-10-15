// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// The Markdown subset allowed in a registry manual (docs/registry-format.md, "Manual
// Markdown"). Strict on purpose: anything outside the subset is an error at build time, so
// what is published is exactly what every renderer, including the app's, will show.
//
// Allowed: headings (# to ####), paragraphs, **strong**, *emphasis*, `code`, fenced code,
// bullet and numbered lists (one level), block quotes, and [text](https://...) links.
// Not allowed: raw HTML, images, other link schemes, nested lists, tables.

export class MarkdownError extends Error {
  constructor(message, line) {
    super(`manual line ${line}: ${message}`);
    this.line = line;
  }
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]*\))/g;
const LINK = /^\[([^\]]+)\]\((https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/?=&#+:@!$'*,;-]*)?)\)$/;

function inline(text, line) {
  // An image is a link with a bang in front; the link syntax alone would hide it.
  if (text.replace(/`[^`\n]*`/g, '').includes('![')) throw new MarkdownError('images are not allowed in a manual', line);
  let out = '';
  let last = 0;
  const plain = (s) => {
    if (/<[A-Za-z/!?]/.test(s)) throw new MarkdownError('raw HTML is not allowed', line);
    if (s.includes('![')) throw new MarkdownError('images are not allowed in a manual', line);
    if (/\]\(/.test(s)) throw new MarkdownError('link must be [text](https://...)', line);
    return esc(s);
  };
  for (const m of text.matchAll(INLINE)) {
    out += plain(text.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out += `<code>${esc(tok.slice(1, -1))}</code>`;
    else if (m[2]) out += `<strong>${inline(tok.slice(2, -2), line)}</strong>`;
    else if (m[3]) out += `<em>${inline(tok.slice(1, -1), line)}</em>`;
    else {
      const link = LINK.exec(tok);
      if (!link) throw new MarkdownError(`link must be [text](https://...): ${tok}`, line);
      out += `<a href="${esc(link[2])}" rel="noopener noreferrer">${esc(link[1])}</a>`;
    }
    last = m.index + tok.length;
  }
  out += plain(text.slice(last));
  return out;
}

/** Render a manual to HTML. Headings start at h3 because the page already has an h1 and h2. */
export function renderMarkdown(src) {
  if (/\r/.test(src)) throw new MarkdownError('use LF line endings', 1);
  const lines = src.split('\n');
  const html = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) {
      html.push(`<p>${inline(para.map((p) => p.text).join(' '), para[0].n)}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const raw = lines[i];
    const n = i + 1;
    if (/^```/.test(raw)) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      if (i >= lines.length) throw new MarkdownError('code fence is not closed', n);
      i++;
      html.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (raw.trim() === '') {
      flush();
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.+?)\s*$/.exec(raw);
    if (h) {
      flush();
      const level = h[1].length + 2;
      html.push(`<h${level}>${inline(h[2], n)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s+([-*]|\d+\.)\s/.test(raw)) throw new MarkdownError('nested lists are not allowed', n);
    const ul = /^[-*]\s+(.*)$/.exec(raw);
    const ol = /^\d+\.\s+(.*)$/.exec(raw);
    if (ul || ol) {
      flush();
      const items = [];
      const re = ul ? /^[-*]\s+(.*)$/ : /^\d+\.\s+(.*)$/;
      while (i < lines.length && re.test(lines[i])) {
        items.push(`<li>${inline(re.exec(lines[i])[1], i + 1)}</li>`);
        i++;
      }
      const tag = ul ? 'ul' : 'ol';
      html.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(raw)) {
      flush();
      const quote = [];
      const first = n;
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote><p>${inline(quote.join(' ').trim(), first)}</p></blockquote>`);
      continue;
    }
    if (/^\|/.test(raw)) throw new MarkdownError('tables are not allowed', n);
    para.push({ text: raw.trim(), n });
    i++;
  }
  flush();
  return html.join('\n');
}
