// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDES, DocError, docsSitemap, guidePage, renderDocs } from '../lib/docs.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = 'https://sanctum.enigma.sh';
const guide = GUIDES[0];

test('a guide becomes a page with its title, canonical address and no script', () => {
  const html = guidePage(guide, '# Hello guide\n\nSome text with `code`.\n', { siteUrl: SITE });
  assert.match(html, /<title>Hello guide \| Sanctum<\/title>/);
  assert.match(html, new RegExp(`rel="canonical" href="${SITE}/docs/${guide.slug}/"`));
  assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /href="\.\.\/\.\.\/styles\.css"/);
});

test('em and en dashes, a missing title and raw HTML are refused', () => {
  assert.throws(() => guidePage(guide, '# T\n\nOne \u2014 two.\n', { siteUrl: SITE }), DocError);
  assert.throws(() => guidePage(guide, 'No title here.\n', { siteUrl: SITE }), DocError);
  assert.throws(() => guidePage(guide, '# T\n\n<b>x</b> and ![i](https://x.y/i.png)\n', { siteUrl: SITE }));
});

test('the sitemap block is rewritten between its markers and nothing else', () => {
  const xml = '<urlset>\n  <!-- docs:begin -->\n  <!-- docs:end -->\n  <other/>\n</urlset>';
  const out = docsSitemap(xml, GUIDES, { siteUrl: SITE });
  assert.match(out, /<loc>https:\/\/sanctum\.enigma\.sh\/docs\/run-your-own-registry\/<\/loc>/);
  assert.ok(out.includes('<other/>'));
  assert.throws(() => docsSitemap('<urlset/>', GUIDES, { siteUrl: SITE }), DocError);
});

test('every command in the registry guide names a script or option that exists', () => {
  const md = readFileSync(join(repo, 'docs', guide.src), 'utf8');
  for (const script of md.match(/scripts\/[a-z-]+\.(?:sh|mjs)/g) ?? []) {
    assert.ok(readFileSync(join(repo, script), 'utf8').length > 0, script);
  }
  const builder = readFileSync(join(repo, 'scripts/build-registry.mjs'), 'utf8');
  for (const flag of ['--source', '--bundles', '--out', '--site', '--sitemap', '--anchor', '--renew']) {
    assert.ok(md.includes(flag), `guide uses ${flag}`);
    assert.ok(builder.includes(`'${flag}'`), `builder knows ${flag}`);
  }
});

test('the committed site page matches the guide', () => {
  const files = renderDocs((f) => readFileSync(join(repo, 'docs', f), 'utf8'), { siteUrl: SITE });
  for (const [rel, text] of files) {
    assert.equal(readFileSync(join(repo, 'web/docs', rel), 'utf8'), text, rel);
  }
});

test('the docs index lists every guide, and every kind of page links to the docs', () => {
  const files = renderDocs((f) => readFileSync(join(repo, 'docs', f), 'utf8'), { siteUrl: SITE });
  const index = files.get('index.html');
  for (const g of GUIDES) assert.ok(index.includes(`href="./${g.slug}/"`), g.slug);
  for (const page of ['web/index.html', 'web/blog/index.html', 'web/apps/index.html', 'web/docs/index.html']) {
    assert.match(readFileSync(join(repo, page), 'utf8'), /<a href="[^"]*docs\/">Docs<\/a>/, page);
  }
});
