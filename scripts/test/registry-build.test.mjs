// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// End to end: build a registry from synthetic sources and real signed bundles, sign it with
// the Rust CLI, verify it with the Node reference. Every tamper below must be caught.

import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildRegistry, diffDir, writeRegistry } from '../lib/registry.mjs';
import { renderSite, renderSitemap } from '../lib/site.mjs';
import { verifyRegistryDir } from '../lib/verify-registry.mjs';
import { NOW, ONE_PIXEL_PNG, REGISTRY_ID, cli, makeWorld } from './helpers.mjs';

const DAY = 86_400;

function build(w, over = {}) {
  const b = buildRegistry({ sourceDir: w.source, bundlesDir: w.bundles, outDir: w.out, anchors: w.anchors, now: NOW, ...over });
  writeRegistry(w.out, b.files);
  return b;
}
const verify = (w, over = {}) => verifyRegistryDir({ dir: w.out, anchors: w.anchors, now: NOW + DAY, expectedId: REGISTRY_ID, ...over });
function files(dir, base = dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, base) : [p.slice(base.length + 1)];
  });
}

test('build, sign with the Rust CLI, verify with the Node reference', () => {
  const w = makeWorld();
  try {
    const b = build(w);
    assert.equal(b.index.apps.length, 2);
    assert.deepEqual(b.changed, { index: true, revocations: true });
    // Unsigned output is not valid, and says why.
    assert.match(verify(w).problems.join('\n'), /index\.json\.sig: missing/);
    w.signAll();
    const r = verify(w);
    assert.deepEqual(r.problems, []);
    assert.equal(r.index.serial, 1);
  } finally {
    w.cleanup();
  }
});

test('rebuilding with nothing changed keeps the serial and the signature', () => {
  const w = makeWorld();
  try {
    build(w);
    w.signAll();
    const sigBefore = readFileSync(join(w.out, 'index.json.sig'));
    const b = build(w, { now: NOW + 5 * DAY });
    assert.deepEqual(b.changed, { index: false, revocations: false });
    assert.equal(b.serial.index, 1);
    assert.ok(readFileSync(join(w.out, 'index.json.sig')).equals(sigBefore));
    assert.deepEqual(verify(w).problems, []);
  } finally {
    w.cleanup();
  }
});

test('a content change bumps the serial, drops the stale signature, and needs re-signing', () => {
  const w = makeWorld();
  try {
    build(w);
    w.signAll();
    const dir = join(w.source, 'apps/sh.test.alpha');
    writeFileSync(join(dir, 'app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 'changed summary', description: 'd' }));
    const b = build(w, { now: NOW + 2 * DAY });
    assert.deepEqual(b.changed, { index: true, revocations: false });
    assert.equal(b.serial.index, 2);
    assert.equal(b.serial.revocations, 1);
    assert.ok(!existsSync(join(w.out, 'index.json.sig')), 'old index signature must be removed');
    assert.ok(existsSync(join(w.out, 'revocations.json.sig')), 'unchanged revocations keep their signature');
    assert.match(verify(w).problems.join('\n'), /index\.json\.sig: missing/);
    w.signAll();
    assert.deepEqual(verify(w).problems, []);
  } finally {
    w.cleanup();
  }
});

test('--renew re-issues with a new serial and fresh expiry', () => {
  const w = makeWorld();
  try {
    build(w);
    const b = build(w, { now: NOW + 60 * DAY, renew: true });
    assert.deepEqual(b.changed, { index: true, revocations: true });
    assert.equal(b.serial.index, 2);
    const idx = JSON.parse(readFileSync(join(w.out, 'index.json'), 'utf8'));
    assert.equal(idx.issued_at, NOW + 60 * DAY);
    assert.equal(idx.expires, NOW + 60 * DAY + 90 * DAY);
  } finally {
    w.cleanup();
  }
});

test('output is deterministic: two clean builds are byte-identical', () => {
  const a = makeWorld();
  try {
    const one = buildRegistry({ sourceDir: a.source, bundlesDir: a.bundles, outDir: join(a.dir, 'nowhere'), anchors: a.anchors, now: NOW });
    const two = buildRegistry({ sourceDir: a.source, bundlesDir: a.bundles, outDir: join(a.dir, 'nowhere'), anchors: a.anchors, now: NOW });
    assert.deepEqual([...one.files.keys()], [...two.files.keys()]);
    for (const [k, v] of one.files) assert.ok(v.equals(two.files.get(k)), k);
  } finally {
    a.cleanup();
  }
});

test('the check mode notices drift in any file', () => {
  const w = makeWorld();
  try {
    const b = build(w);
    assert.deepEqual(diffDir(w.out, b.files), []);
    appendFileSync(join(w.out, 'apps/sh.test.alpha/manual.md'), 'x');
    rmSync(join(w.out, 'apps/sh.test.beta.json'));
    writeFileSync(join(w.out, 'extra.txt'), 'x');
    assert.deepEqual(
      diffDir(w.out, b.files).sort(),
      ['changed: apps/sh.test.alpha/manual.md', 'missing: apps/sh.test.beta.json', 'stale: extra.txt'],
    );
  } finally {
    w.cleanup();
  }
});

// ── Tampering after signing ───────────────────────────────────────────────────

function signedWorld() {
  const w = makeWorld();
  const b = build(w);
  writeFileSync(join(w.source, 'apps/sh.test.alpha/keep'), ''); // sources are not part of the registry
  rmSync(join(w.source, 'apps/sh.test.alpha/keep'));
  w.signAll();
  assert.deepEqual(verify(w).problems, [], 'baseline must verify');
  return { w, b };
}

test('every kind of file in a signed registry is protected', () => {
  const { w, b } = signedWorld();
  try {
    const mutate = {
      'index.json': (p) => appendFileSync(p, ' '),
      'revocations.json': (p) => appendFileSync(p, ' '),
      'bundles/sh.test.alpha-1.0.0.sanctum': (p) => appendFileSync(p, ' '),
      'apps/sh.test.alpha.json': (p) => appendFileSync(p, ' '),
      'apps/sh.test.alpha/manual.md': (p) => appendFileSync(p, ' '),
      'apps/sh.test.alpha/icon.svg': (p) => appendFileSync(p, ' '),
    };
    for (const rel of b.files.keys()) assert.ok(rel in mutate || rel.endsWith('.json') || rel.endsWith('.md') || rel.endsWith('.svg') || rel.endsWith('.sanctum'));
    for (const [rel, fn] of Object.entries(mutate)) {
      const p = join(w.out, rel);
      const original = readFileSync(p);
      fn(p);
      assert.notDeepEqual(verify(w).problems, [], `tampering with ${rel} went unnoticed`);
      writeFileSync(p, original);
      assert.deepEqual(verify(w).problems, [], `restoring ${rel} should heal`);
    }
  } finally {
    w.cleanup();
  }
});

test('an unlisted file in the registry directory is flagged', () => {
  const { w } = signedWorld();
  try {
    writeFileSync(join(w.out, 'bundles/sneaky.sanctum'), 'x');
    assert.match(verify(w).problems.join('\n'), /sneaky\.sanctum: not referenced/);
  } finally {
    w.cleanup();
  }
});

test('swapping a bundle for another valid signed bundle is caught by its size or hash', () => {
  const { w } = signedWorld();
  try {
    // A genuinely signed, anchored bundle of the same app and version, but different bytes.
    const other = w.signBundle({ app: 'alpha', version: '1.0.0', html: '<!doctype html><title>Other</title>', into: join(w.dir, 'elsewhere') });
    const bytes = readFileSync(other);
    writeFileSync(join(w.out, 'bundles/sh.test.alpha-1.0.0.sanctum'), bytes);
    assert.match(verify(w).problems.join('\n'), /size_mismatch|hash_mismatch/);
  } finally {
    w.cleanup();
  }
});

test('an index that disagrees with the signed bundle is caught even when it is validly signed', () => {
  const w = makeWorld();
  try {
    const b = build(w);
    // Re-issue the index with a different declared list, as a compromised builder might.
    const idx = JSON.parse(b.files.get('index.json').toString('utf8'));
    idx.apps[0].versions[0].declared = [];
    writeFileSync(join(w.out, 'index.json'), `${JSON.stringify(idx, null, 2)}\n`);
    w.signAll();
    assert.match(verify(w).problems.join('\n'), /does not match the index entry/);
  } finally {
    w.cleanup();
  }
});

test('a revoked version that is still listed is a problem', () => {
  const w = makeWorld();
  try {
    const first = build(w);
    const checksum = JSON.parse(first.files.get('index.json').toString('utf8')).apps[0].versions[0].checksum;
    writeFileSync(
      join(w.source, 'revocations.json'),
      JSON.stringify({ entries: [{ checksum, app_id: 'sh.test.alpha', version: '1.0.0', reason: 'vulnerable', revoked_at: NOW - 10 }] }),
    );
    build(w, { now: NOW + DAY });
    w.signAll();
    assert.match(verify(w, { now: NOW + 2 * DAY }).problems.join('\n'), /revoked but still listed/);
  } finally {
    w.cleanup();
  }
});

test('an expired registry fails unless stale files are allowed', () => {
  const { w } = signedWorld();
  try {
    const later = NOW + 100 * DAY;
    const strict = verify(w, { now: later });
    assert.match(strict.problems.join('\n'), /index\.json: expired/);
    const lenient = verify(w, { now: later, allowStale: true });
    assert.deepEqual(lenient.problems, []);
    assert.ok(lenient.warnings.length >= 1);
  } finally {
    w.cleanup();
  }
});

test('revocations expire sooner than the index', () => {
  const { w } = signedWorld();
  try {
    const r = verify(w, { now: NOW + 20 * DAY });
    assert.match(r.problems.join('\n'), /revocations\.json: expired/);
    assert.ok(!/index\.json: expired/.test(r.problems.join('\n')));
  } finally {
    w.cleanup();
  }
});

// ── Who may sign ──────────────────────────────────────────────────────────────

test('the CLI refuses to sign with a certificate that covers apps but not the registry', () => {
  const w = makeWorld();
  try {
    build(w);
    const r = w.sign(join(w.out, 'index.json'), 'index', { key: 'publisher', cert: 'publisherAsRegistry' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not cover registry:sh\.test\.public/);
    assert.ok(!existsSync(join(w.out, 'index.json.sig')));
  } finally {
    w.cleanup();
  }
});

test('an index signed by an unknown key is not anchored, even if revocations are fine', () => {
  const w = makeWorld();
  try {
    build(w);
    const idx = join(w.out, 'index.json');
    const r = cli('registry-sign', '--kind', 'index', '--key', w.files.rogue, '--file', idx, '--out', `${idx}.sig`);
    assert.equal(r.status, 0, r.stderr);
    const rev = join(w.out, 'revocations.json');
    cli('registry-sign', '--kind', 'revocations', '--key', w.files.registry, '--file', rev, '--cert', w.certs.registry, '--out', `${rev}.sig`);
    const problems = verify(w).problems.join('\n');
    assert.match(problems, /index\.json: signer is not anchored/);
    assert.ok(!/revocations\.json: signer/.test(problems));
  } finally {
    w.cleanup();
  }
});

test('revocations signed by an unknown key are not anchored either', () => {
  const w = makeWorld();
  try {
    build(w);
    const idx = join(w.out, 'index.json');
    cli('registry-sign', '--kind', 'index', '--key', w.files.registry, '--file', idx, '--cert', w.certs.registry, '--out', `${idx}.sig`);
    const rev = join(w.out, 'revocations.json');
    cli('registry-sign', '--kind', 'revocations', '--key', w.files.rogue, '--file', rev, '--out', `${rev}.sig`);
    assert.match(verify(w).problems.join('\n'), /revocations\.json: signer is not anchored/);
  } finally {
    w.cleanup();
  }
});

test('an index that names a different publisher key than the bundle was signed with is caught', () => {
  const w = makeWorld();
  try {
    const b = build(w);
    const idx = JSON.parse(b.files.get('index.json').toString('utf8'));
    idx.apps[0].publisher.keyid = w.keys.rogue.keyid;
    writeFileSync(join(w.out, 'index.json'), `${JSON.stringify(idx, null, 2)}\n`);
    w.signAll();
    assert.match(verify(w).problems.join('\n'), /not the publisher key listed in the index/);
  } finally {
    w.cleanup();
  }
});

test('the CLI will not sign the wrong kind of file', () => {
  const w = makeWorld();
  try {
    build(w);
    const r = cli('registry-sign', '--kind', 'revocations', '--key', w.files.registry, '--file', join(w.out, 'index.json'), '--cert', w.certs.registry, '--out', join(w.dir, 'x.sig'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is not a sanctum-registry-revocations\/1 file/);
  } finally {
    w.cleanup();
  }
});

// ── Refusals at build time ────────────────────────────────────────────────────

const buildOnly = (w, over = {}) => buildRegistry({ sourceDir: w.source, bundlesDir: w.bundles, outDir: w.out, anchors: w.anchors, now: NOW, ...over });

test('a bundle not anchored to the trusted root cannot be published', () => {
  const w = makeWorld({ apps: ['alpha'] });
  try {
    w.signBundle({ app: 'alpha', version: '1.0.1', signer: 'rogue', cert: 'rogue' });
    writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 's', description: 'd', versions: ['1.0.1'] }));
    writeFileSync(join(w.source, 'apps/sh.test.alpha/CHANGELOG.md'), '## 1.0.1 (2027-01-14)\n- added: x\n');
    assert.throws(() => buildOnly(w), /not anchored to a trusted key/);
  } finally {
    w.cleanup();
  }
});

test('a bundle whose signed statement was edited is refused', () => {
  const w = makeWorld({ apps: ['alpha'] });
  try {
    const p = join(w.bundles, 'sh.test.alpha-1.0.0.sanctum');
    const b = JSON.parse(readFileSync(p, 'utf8'));
    const st = JSON.parse(Buffer.from(b.signature.payload, 'base64url').toString('utf8'));
    st.declared = []; // claim less than the tool uses, keeping the old signature
    b.signature.payload = Buffer.from(JSON.stringify(st)).toString('base64url');
    writeFileSync(p, JSON.stringify(b));
    assert.throws(() => buildOnly(w), /signature does not verify/);
  } finally {
    w.cleanup();
  }
});

test('a bundle with a damaged signature is refused', () => {
  const w = makeWorld({ apps: ['alpha'] });
  try {
    const p = join(w.bundles, 'sh.test.alpha-1.0.0.sanctum');
    const b = JSON.parse(readFileSync(p, 'utf8'));
    const sig = Buffer.from(b.signature.sig, 'base64url');
    sig[0] ^= 1;
    b.signature.sig = sig.toString('base64url');
    writeFileSync(p, JSON.stringify(b));
    assert.throws(() => buildOnly(w), /signature does not verify/);
  } finally {
    w.cleanup();
  }
});

test('a bundle with a tampered file is refused', () => {
  const w = makeWorld({ apps: ['alpha'] });
  try {
    const p = join(w.bundles, 'sh.test.alpha-1.0.0.sanctum');
    const b = JSON.parse(readFileSync(p, 'utf8'));
    b.html += '<!-- injected -->';
    writeFileSync(p, JSON.stringify(b));
    assert.throws(() => buildOnly(w), /does not match the signed checksum/);
  } finally {
    w.cleanup();
  }
});

test('source mistakes stop the build with a clear message', () => {
  const cases = {
    'app id differs from folder': (w) => writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.other', summary: 's', description: 'd' })),
    'missing description': (w) => writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 's' })),
    'changelog lacks the published version': (w) => writeFileSync(join(w.source, 'apps/sh.test.alpha/CHANGELOG.md'), '## 0.9.0 (2027-01-01)\n- added: x\n'),
    'manual contains HTML': (w) => writeFileSync(join(w.source, 'apps/sh.test.alpha/manual.md'), 'Hi <b>there</b>\n'),
    'version listed but no bundle': (w) => writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 's', description: 'd', versions: ['9.9.9'] })),
    'screenshot is not an image': (w) => {
      mkdirSync(join(w.source, 'apps/sh.test.alpha/screenshots'), { recursive: true });
      writeFileSync(join(w.source, 'apps/sh.test.alpha/screenshots/a.png'), 'not a png');
      writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 's', description: 'd', screenshots: [{ file: 'a.png', alt: 'x' }] }));
    },
    'summary too long': (w) => writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 'x'.repeat(201), description: 'd' })),
    'app has no bundle at all': (w) => rmSync(join(w.bundles, 'sh.test.alpha-1.0.0.sanctum')),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const w = makeWorld({ apps: ['alpha'] });
    try {
      mutate(w);
      assert.throws(() => buildOnly(w), Error, name);
    } finally {
      w.cleanup();
    }
  }
});

test('screenshots are measured, hashed and published', () => {
  const w = makeWorld({ apps: ['alpha'] });
  try {
    mkdirSync(join(w.source, 'apps/sh.test.alpha/screenshots'), { recursive: true });
    writeFileSync(join(w.source, 'apps/sh.test.alpha/screenshots/first.png'), ONE_PIXEL_PNG);
    writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 's', description: 'd', screenshots: [{ file: 'first.png', alt: 'A single pixel' }] }));
    const b = build(w);
    const detail = JSON.parse(b.files.get('apps/sh.test.alpha.json').toString('utf8'));
    assert.deepEqual(detail.screenshots.map((s) => [s.path, s.width, s.height, s.alt]), [['apps/sh.test.alpha/first.png', 1, 1, 'A single pixel']]);
    w.signAll();
    assert.deepEqual(verify(w).problems, []);
    // Swapping the screenshot for a different image of the same name is caught.
    writeFileSync(join(w.out, 'apps/sh.test.alpha/first.png'), Buffer.concat([ONE_PIXEL_PNG, Buffer.from('x')]));
    assert.match(verify(w).problems.join('\n'), /size_mismatch|hash_mismatch/);
  } finally {
    w.cleanup();
  }
});

test('older versions are published only when app.json lists them', () => {
  const w = makeWorld({ apps: ['alpha'] });
  try {
    w.signBundle({ app: 'alpha', version: '1.1.0' });
    writeFileSync(join(w.source, 'apps/sh.test.alpha/CHANGELOG.md'), '## 1.1.0 (2027-01-14)\n- added: y\n\n## 1.0.0 (2027-01-10)\n- added: x\n');
    let b = buildOnly(w);
    assert.deepEqual(b.index.apps[0].versions.map((v) => v.version), ['1.1.0']);
    assert.equal(b.index.apps[0].latest, '1.1.0');
    writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: 's', description: 'd', versions: ['1.0.0', '1.1.0'] }));
    b = buildOnly(w);
    assert.deepEqual(b.index.apps[0].versions.map((v) => v.version), ['1.1.0', '1.0.0']);
  } finally {
    w.cleanup();
  }
});

// ── Site pages ────────────────────────────────────────────────────────────────

test('generated pages have no script, no third-party URL and no dashes in copy', () => {
  const w = makeWorld();
  try {
    const b = build(w);
    const site = renderSite(b);
    assert.deepEqual([...site.keys()].sort(), ['index.html', 'sh.test.alpha/index.html', 'sh.test.beta/index.html']);
    const allowed = /^https:\/\/(github\.com\/Enigma-Technologies-Solutions\/sanctum|example\.test)/;
    for (const [name, bytes] of site) {
      const html = bytes.toString('utf8');
      assert.ok(!/<script/i.test(html), `${name}: script tag`);
      assert.ok(!/\son\w+\s*=/i.test(html), `${name}: inline handler`);
      assert.ok(!/http:\/\//.test(html), `${name}: plain http URL`);
      assert.ok(!/[–—]/.test(html), `${name}: en or em dash`);
      for (const m of html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) assert.match(m[1], allowed, `${name}: ${m[1]}`);
      assert.match(html, /script-src 'none'/);
      assert.match(html, /<meta name="viewport"/);
    }
    const page = site.get('sh.test.alpha/index.html').toString('utf8');
    assert.match(page, /Use it/); // manual rendered
    assert.match(page, /First release/); // changelog
    assert.match(page, /Asks for: Storage/);
    assert.match(page, /href="\.\.\/\.\.\/registry\/v1\/bundles\/sh\.test\.alpha-1\.0\.0\.sanctum"/);
  } finally {
    w.cleanup();
  }
});

test('page text is escaped', () => {
  const w = makeWorld({ apps: ['alpha'] });
  try {
    writeFileSync(join(w.source, 'apps/sh.test.alpha/app.json'), JSON.stringify({ app_id: 'sh.test.alpha', summary: '<img src=x onerror=alert(1)>', description: '"><script>alert(1)</script>' }));
    const html = renderSite(build(w)).get('sh.test.alpha/index.html').toString('utf8');
    assert.ok(!html.includes('<img src=x'));
    assert.ok(!/<script/i.test(html));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  } finally {
    w.cleanup();
  }
});

test('the sitemap block is rewritten between its markers and nothing else', () => {
  const w = makeWorld();
  try {
    const b = build(w);
    const xml = '<urlset>\n  <url><loc>https://example.test/</loc></url>\n  <!-- registry:begin -->\n  <!-- registry:end -->\n</urlset>\n';
    const out = renderSitemap(xml, b);
    assert.match(out, /<url><loc>https:\/\/example\.test\/<\/loc><\/url>/);
    assert.match(out, /<loc>https:\/\/example\.test\/apps\/<\/loc>/);
    assert.match(out, /<loc>https:\/\/example\.test\/apps\/sh\.test\.alpha\/<\/loc>/);
    assert.equal(renderSitemap(out, b), out, 'idempotent');
    assert.throws(() => renderSitemap('<urlset></urlset>', b), /markers/);
  } finally {
    w.cleanup();
  }
});

test('the files list for the registry contains exactly what the index references', () => {
  const w = makeWorld();
  try {
    build(w);
    w.signAll();
    const present = files(w.out).sort();
    assert.deepEqual(present, [
      'apps/sh.test.alpha.json',
      'apps/sh.test.alpha/icon.svg',
      'apps/sh.test.alpha/manual.md',
      'apps/sh.test.beta.json',
      'apps/sh.test.beta/icon.svg',
      'apps/sh.test.beta/manual.md',
      'bundles/sh.test.alpha-1.0.0.sanctum',
      'bundles/sh.test.beta-1.0.0.sanctum',
      'index.json',
      'index.json.sig',
      'revocations.json',
      'revocations.json.sig',
    ]);
  } finally {
    w.cleanup();
  }
});
