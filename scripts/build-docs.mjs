#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
//   node scripts/build-docs.mjs            write web/docs/ and the sitemap block
//   node scripts/build-docs.mjs --check    fail if what is committed differs from docs/
//
// The guides listed in scripts/lib/docs.mjs are written once, in docs/, and published here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocError, GUIDES, docsSitemap, renderDocs } from './lib/docs.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://sanctum.enigma.sh';

function main(argv) {
  const check = argv.includes('--check');
  const files = renderDocs((f) => readFileSync(join(repo, 'docs', f), 'utf8'), { siteUrl: SITE });
  const outDir = join(repo, 'web/docs');
  const sitemapPath = join(repo, 'web/sitemap.xml');
  const sitemap = docsSitemap(readFileSync(sitemapPath, 'utf8'), GUIDES, { siteUrl: SITE });

  if (check) {
    const stale = [];
    for (const [rel, text] of files) {
      const f = join(outDir, rel);
      if (!existsSync(f) || readFileSync(f, 'utf8') !== text) stale.push(`docs/${rel}`);
    }
    if (readFileSync(sitemapPath, 'utf8') !== sitemap) stale.push('sitemap.xml');
    if (stale.length) {
      console.error(`The committed guides are out of date:\n${stale.map((s) => `  ${s}`).join('\n')}\nRun: node scripts/build-docs.mjs`);
      process.exit(1);
    }
    console.log(`Guides up to date (${files.size}).`);
    return;
  }
  for (const [rel, text] of files) {
    const f = join(outDir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  writeFileSync(sitemapPath, sitemap);
  console.log(`Guides: ${files.size} written.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof DocError || e?.name === 'MarkdownError') {
      console.error(`error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
