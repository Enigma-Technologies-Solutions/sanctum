// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { LATEST, PLATFORMS, downloadPage, downloadScript, withoutDownloadScript } from '../lib/download.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const web = join(repo, 'web');

/** Run download.js against a fake browser and return what the links became. */
function run({ ua, platform = '', touch = 0, uaPlatform }) {
  const text = (v) => ({ nodeType: 3, nodeValue: v, nextSibling: null });
  const link = (kind) => {
    const attrs = { 'data-download': kind, rel: 'noopener' };
    const t = text('Download ');
    return {
      href: './download/', firstChild: t, attrs, label: () => t.nodeValue,
      getAttribute: (k) => attrs[k] ?? null, removeAttribute: (k) => delete attrs[k],
    };
  };
  const links = [link(''), link('label')];
  const marked = [];
  const document = {
    querySelectorAll: () => links,
    querySelector: (sel) => ({ classList: { add: () => marked.push(sel) } }),
  };
  const navigator = { userAgent: ua, platform, maxTouchPoints: touch, userAgentData: uaPlatform ? { platform: uaPlatform } : undefined };
  vm.runInNewContext(downloadScript(), { window: { navigator }, document });
  return { href: links[0].href, label: links[1].label(), rel: links[0].attrs.rel, marked };
}

const file = (key) => LATEST + PLATFORMS.find((p) => p.key === key).files[0].file;

test('the script points Download straight at the right installer', () => {
  const mac = run({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel' });
  assert.equal(mac.href, file('mac'));
  assert.equal(mac.label, 'Download for macOS ');
  assert.equal(mac.rel, undefined);
  assert.deepEqual(mac.marked, ['[data-platform="mac"]']);
  assert.equal(run({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', platform: 'Win32', uaPlatform: 'Windows' }).href, file('win'));
  assert.equal(run({ ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', platform: 'Linux x86_64' }).href, file('linux-x86_64'));
  assert.equal(run({ ua: 'Mozilla/5.0 (X11; Linux aarch64) Chrome/130.0', platform: 'Linux aarch64', uaPlatform: 'Linux' }).label, 'Download for Linux ');
  assert.equal(run({ ua: 'Mozilla/5.0 (X11; Linux aarch64) Chrome/130.0', platform: 'Linux aarch64' }).href, file('linux-arm64'));
});

test('the script leaves the links alone when it cannot tell', () => {
  for (const nav of [
    { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', platform: 'iPhone' },
    { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', touch: 5 }, // iPad
    { ua: 'Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile', platform: 'Linux armv8l' },
    { ua: 'Mozilla/5.0 (X11; Linux armv7l) Chrome/130.0', platform: 'Linux armv7l' },
    { ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/130.0', platform: 'Linux x86_64' },
    { ua: '', platform: '' },
  ]) {
    const r = run(nav);
    assert.equal(r.href, './download/', nav.ua);
    assert.equal(r.label, 'Download ');
  }
});

test('the download page lists every installer, links only to the latest release, and is committed', () => {
  const html = downloadPage({ siteUrl: 'https://sanctum.enigma.sh' });
  for (const p of PLATFORMS) for (const f of p.files) assert.ok(html.includes(`href="${LATEST}${f.file}"`), f.file);
  assert.ok(!/[–—]/.test(html));
  assert.ok(!/<script/i.test(withoutDownloadScript(html)));
  assert.equal(readFileSync(join(web, 'download/index.html'), 'utf8'), html);
  assert.equal(readFileSync(join(web, 'assets/download.js'), 'utf8'), downloadScript());
});

test('every stable name is attached by the release workflow', () => {
  const wf = readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8');
  for (const p of PLATFORMS) for (const f of p.files) assert.ok(wf.includes(f.file), `${f.file} missing from release.yml`);
});

test('every page on the site uses only the download script, and every Download button goes to /download/', () => {
  const pages = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n.startsWith('.')) continue;
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else if (n.endsWith('.html')) pages.push(f);
    }
  };
  walk(web);
  assert.ok(pages.length > 10);
  for (const f of pages) {
    const html = readFileSync(f, 'utf8');
    assert.ok(!/<script/i.test(withoutDownloadScript(html)), `${f}: other script`);
    assert.ok(!/script-src 'none'/.test(html), `${f}: old CSP`);
    assert.ok(!/releases\/latest" rel="noopener">(Download|Get Sanctum|Latest release)/.test(html), `${f}: Download goes to GitHub`);
  }
});
