// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shell } from '../lib/site.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Link labels and targets of the nav, with the page depth taken out of the targets. */
function nav(html, strip) {
  const block = /<nav class="nav"[\s\S]*?<\/nav>/.exec(html)[0];
  return [...block.matchAll(/<a [^>]*?href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .filter(([, , label]) => label !== 'SANCTUM')
    .map(([, href, label]) => `${label} -> ${strip(href)}`);
}

test('generated pages carry the same nav as the home page', () => {
  const home = nav(readFileSync(join(repo, 'web/index.html'), 'utf8'), (h) => h.replace(/^\.\//, ''));
  for (const depth of [1, 2]) {
    const page = shell({ title: 't', description: 'd', canonical: 'https://x.test/', depth, body: '' });
    const up = '../'.repeat(depth);
    const got = nav(page, (h) => (h.startsWith('https:') ? h : h.slice(up.length)));
    assert.deepEqual(got, home);
  }
});
