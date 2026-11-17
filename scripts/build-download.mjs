#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
//   node scripts/build-download.mjs            write web/download/index.html and web/assets/download.js
//   node scripts/build-download.mjs --check    fail if what is committed differs
//
// Both files come from scripts/lib/download.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadPage, downloadScript } from './lib/download.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://sanctum.enigma.sh';

const files = new Map([
  ['web/download/index.html', downloadPage({ siteUrl: SITE })],
  ['web/assets/download.js', downloadScript()],
]);

if (process.argv.includes('--check')) {
  const stale = [...files].filter(([rel, text]) => {
    const f = join(repo, rel);
    return !existsSync(f) || readFileSync(f, 'utf8') !== text;
  });
  if (stale.length) {
    console.error(`out of date, run node scripts/build-download.mjs:\n  ${stale.map(([r]) => r).join('\n  ')}`);
    process.exit(1);
  }
  console.log('download page and script are up to date');
} else {
  for (const [rel, text] of files) {
    const f = join(repo, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    console.log(`wrote ${rel}`);
  }
}
