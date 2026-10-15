// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChangelog } from '../lib/changelog.mjs';
import { imageSize } from '../lib/images.mjs';
import { MarkdownError, renderMarkdown } from '../lib/markdown.mjs';
import { extractIconSvg } from '../lib/registry.mjs';
import { ONE_PIXEL_PNG } from './helpers.mjs';

// ── Markdown ──────────────────────────────────────────────────────────────────

test('markdown renders the allowed subset', () => {
  const html = renderMarkdown(
    ['## Title', '', 'Some **bold**, *soft* and `code` with [a link](https://example.test/a?b=1).', '', '- one', '- two', '', '1. first', '2. second', '', '> quoted', '', '```', 'let x = "<tag>";', '```'].join('\n'),
  );
  assert.match(html, /<h4>Title<\/h4>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>soft<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.test\/a\?b=1" rel="noopener noreferrer">a link<\/a>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code>let x = &quot;&lt;tag&gt;&quot;;<\/code><\/pre>/);
});

test('markdown escapes everything it prints', () => {
  const html = renderMarkdown('Fish & chips "quoted" \'single\'\n');
  assert.equal(html, '<p>Fish &amp; chips &quot;quoted&quot; &#39;single&#39;</p>');
});

test('markdown refuses anything outside the subset', () => {
  const bad = {
    'raw html': 'Hello <b>there</b>',
    'html comment': '<!-- hi -->',
    'script tag': '<script>alert(1)</script>',
    image: '![alt](https://example.test/x.png)',
    'http link': '[x](http://example.test/)',
    'javascript link': '[x](javascript:alert(1))',
    'relative link': '[x](../other.md)',
    'link with space': '[x](https://example.test/a b)',
    'nested list': '- one\n  - two',
    table: '| a | b |\n|---|---|',
    'open fence': '```\ncode',
    'crlf line endings': 'a\r\nb',
  };
  for (const [name, src] of Object.entries(bad)) {
    assert.throws(() => renderMarkdown(src), MarkdownError, name);
  }
});

test('markdown allows angle brackets inside code', () => {
  assert.match(renderMarkdown('Use `<div>` here'), /<code>&lt;div&gt;<\/code>/);
});

// ── Changelog ─────────────────────────────────────────────────────────────────

test('changelog parses entries newest first', () => {
  const c = parseChangelog('# Changelog\n\n## 1.1.0 (2026-11-01)\n- added: B.\n- fixed: C.\n\n## 1.0.0 (2026-10-01)\n- added: A.\n');
  assert.deepEqual(
    c.map((e) => [e.version, e.date, e.changes.length]),
    [['1.1.0', '2026-11-01', 2], ['1.0.0', '2026-10-01', 1]],
  );
  assert.deepEqual(c[0].changes[1], { type: 'fixed', text: 'C.' });
});

test('changelog rejects mistakes', () => {
  const bad = {
    'unknown type': '## 1.0.0 (2026-10-01)\n- improved: x\n',
    'not a date': '## 1.0.0 (2026-13-45)\n- added: x\n',
    'bad heading': '## v1 (2026-10-01)\n- added: x\n',
    'duplicate version': '## 1.0.0 (2026-10-01)\n- added: x\n## 1.0.0 (2026-10-02)\n- added: y\n',
    'empty entry': '## 1.0.0 (2026-10-01)\n',
    'stray text': '## 1.0.0 (2026-10-01)\n- added: x\nhello\n',
    'item before heading': '- added: x\n',
    'too long': `## 1.0.0 (2026-10-01)\n- added: ${'x'.repeat(301)}\n`,
    empty: '',
  };
  for (const [name, src] of Object.entries(bad)) assert.throws(() => parseChangelog(src), Error, name);
});

// ── Images ────────────────────────────────────────────────────────────────────

test('image sizes are read from PNG and WebP headers', () => {
  assert.deepEqual(imageSize(ONE_PIXEL_PNG), { type: 'png', width: 1, height: 1 });
  const vp8x = Buffer.alloc(30);
  vp8x.write('RIFF', 0);
  vp8x.writeUInt32LE(22, 4);
  vp8x.write('WEBP', 8);
  vp8x.write('VP8X', 12);
  vp8x.writeUInt32LE(10, 16);
  vp8x.writeUIntLE(1279, 24, 3);
  vp8x.writeUIntLE(799, 27, 3);
  assert.deepEqual(imageSize(vp8x), { type: 'webp', width: 1280, height: 800 });
  assert.throws(() => imageSize(Buffer.from('GIF89a......................')), /not a PNG or WebP/);
  assert.throws(() => imageSize(Buffer.alloc(0)));
});

// ── Icon extraction ───────────────────────────────────────────────────────────

const icon = (svg) => `<head><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}"></head>`;

test('a tool icon is extracted as an SVG file', () => {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32'/></svg>";
  assert.equal(extractIconSvg(icon(svg)), `${svg}\n`);
  assert.equal(extractIconSvg('<head><title>x</title></head>'), null);
  assert.equal(extractIconSvg('<link rel="icon" href="icon.png">'), null);
});

test('an icon that could run or fetch anything is refused', () => {
  for (const bad of [
    "<svg><script>alert(1)</script></svg>",
    "<svg onload='x()'></svg>",
    "<svg><a href='https://x.test'><rect/></a></svg>",
    "<svg><image href='https://x.test/a.png'/></svg>",
    "<svg><foreignObject><div/></foreignObject></svg>",
    "<svg><style>@import url(x)</style></svg>",
    "<svg><use xlink:href='#a'/></svg>",
    '<html></html>',
  ]) {
    assert.throws(() => extractIconSvg(icon(bad)), /icon/, bad);
  }
});
