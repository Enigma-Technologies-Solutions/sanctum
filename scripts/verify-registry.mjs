#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
//   node scripts/verify-registry.mjs [DIR] [--id registry:...] [--allow-stale]
//                                    [--anchor KEYID=NAME ...] [--now UNIX]
//
// Verifies a registry directory (default web/registry/v1) against the Enigma root compiled
// into the app. Exit status is non-zero on any problem.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProductionAnchors } from './lib/registry.mjs';
import { verifyRegistryDir } from './lib/verify-registry.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const o = { anchors: [] };
let dir;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--allow-stale') o.allowStale = true;
  else if (a === '--id') o.id = argv[++i];
  else if (a === '--now') o.now = Number(argv[++i]);
  else if (a === '--anchor') {
    const [keyid, ...name] = argv[++i].split('=');
    o.anchors.push({ keyid, name: name.join('=') });
  } else if (a.startsWith('-')) {
    console.error(`unknown option ${a}`);
    process.exit(2);
  } else dir = a;
}
dir = resolve(dir ?? join(repo, 'web/registry/v1'));
const expectedId = o.id ?? JSON.parse(readFileSync(join(repo, 'registry/registry.json'), 'utf8')).id;
const { problems, warnings, index } = verifyRegistryDir({
  dir,
  anchors: o.anchors.length ? o.anchors : readProductionAnchors(repo),
  now: o.now ?? Math.floor(Date.now() / 1000),
  expectedId,
  allowStale: o.allowStale,
});
for (const w of warnings) console.warn(`warning: ${w}`);
if (problems.length) {
  console.error(`NOT VALID:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`OK. ${expectedId} serial ${index.serial}, ${index.apps.length} apps, signed by an anchored key, every file matches its hash.`);
