// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildVectors, diffAgainstDisk, KEYS, VECTOR_DIR } from '../make-vectors.mjs';
import {
  DOMAIN,
  LIMITS,
  RegistryError,
  checkAsset,
  checkDetail,
  loadSchema,
  sha256Of,
  validate,
  verifyIndex,
  verifyRevocations,
} from '../reference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(VECTOR_DIR, p));
const manifest = JSON.parse(read('vectors.json').toString('utf8'));

function anchorsFor(names) {
  return names.map((n) => manifest.keys[n]);
}

/** Run one vector through the reference verifier and return the same shape `expect` uses. */
function run(c) {
  try {
    if (c.kind === 'index') {
      const r = verifyIndex({
        indexBytes: read(c.index),
        sigBytes: read(c.sig),
        anchors: anchorsFor(c.anchors),
        now: c.now,
        expectedId: c.expected_id,
        lastSeen: c.last_seen ?? null,
      });
      return summary(r);
    }
    if (c.kind === 'revocations') {
      const r = verifyRevocations({
        bytes: read(c.file),
        sigBytes: read(c.sig),
        anchors: anchorsFor(c.anchors),
        now: c.now,
        expectedId: c.expected_id,
        lastSeen: c.last_seen ?? null,
      });
      return summary(r);
    }
    if (c.kind === 'detail') {
      checkDetail(c.entry, read(c.file));
      return { result: 'ok' };
    }
    checkAsset(c.entry, read(c.file));
    return { result: 'ok' };
  } catch (e) {
    if (e instanceof RegistryError) return { result: 'error', error: e.code };
    throw e;
  }
}

function summary(r) {
  const out = { result: 'ok', trust: r.trust, stale: r.stale };
  if (r.trust === 'anchored') out.publisher = r.publisher;
  else out.reason = r.reason;
  return out;
}

test('committed vectors match what the generator produces', () => {
  assert.deepEqual(diffAgainstDisk(buildVectors()), []);
});

test('every vector gets the verdict it declares', () => {
  assert.ok(manifest.cases.length >= 50, 'expected a substantial vector set');
  for (const c of manifest.cases) {
    assert.deepEqual(run(c), c.expect, `case ${c.name}`);
  }
});

test('vector case names are unique and every vector file is used', () => {
  const names = manifest.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  const used = new Set(['vectors.json']);
  for (const c of manifest.cases) for (const k of ['index', 'sig', 'file']) if (c[k]) used.add(c[k]);
  const onDisk = [];
  const walk = (dir, prefix = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else onDisk.push(`${prefix}${e.name}`);
    }
  };
  walk(VECTOR_DIR);
  const unused = onDisk.filter((p) => !used.has(p) && !p.startsWith('assets/'));
  assert.deepEqual(unused, []);
});

test('every error code in the spec is exercised by a vector, or by a unit test below', () => {
  const required = [
    'sig_malformed',
    'bad_signature',
    'malformed_json',
    'format_unsupported',
    'schema_invalid',
    'id_mismatch',
    'from_future',
    'rollback',
    'serial_replay',
    'hash_mismatch',
    'size_mismatch',
  ];
  const seen = new Set(manifest.cases.filter((c) => c.expect.error).map((c) => c.expect.error));
  for (const code of required) assert.ok(seen.has(code), `no vector for ${code}`);
});

test('flipping any single byte of a signed index is rejected', () => {
  const sigBytes = read('index_root_signed/index.json.sig');
  const original = read('index_root_signed/index.json');
  const anchors = anchorsFor(['root']);
  const args = { sigBytes, anchors, now: manifest.cases[0].now, expectedId: manifest.cases[0].expected_id };
  verifyIndex({ ...args, indexBytes: original });
  for (let i = 0; i < original.length; i++) {
    const copy = Buffer.from(original);
    copy[i] ^= 0x01;
    assert.throws(
      () => verifyIndex({ ...args, indexBytes: copy }),
      (e) => e instanceof RegistryError && e.code === 'bad_signature',
      `byte ${i}`,
    );
  }
});

test('flipping any single byte of the signature is rejected', () => {
  const indexBytes = read('index_root_signed/index.json');
  const sigDoc = JSON.parse(read('index_root_signed/index.json.sig').toString('utf8'));
  const sig = Buffer.from(sigDoc.sig, 'base64url');
  const anchors = anchorsFor(['root']);
  for (let i = 0; i < sig.length; i++) {
    const copy = Buffer.from(sig);
    copy[i] ^= 0x01;
    const doc = { ...sigDoc, sig: copy.toString('base64url') };
    assert.throws(
      () =>
        verifyIndex({
          indexBytes,
          sigBytes: Buffer.from(JSON.stringify(doc)),
          anchors,
          now: manifest.cases[0].now,
          expectedId: manifest.cases[0].expected_id,
        }),
      (e) => e instanceof RegistryError && ['bad_signature', 'sig_malformed'].includes(e.code),
      `sig byte ${i}`,
    );
  }
});

test('oversize files are refused before any parsing', () => {
  const big = Buffer.alloc(LIMITS.index + 1, 0x20);
  assert.throws(
    () => verifyIndex({ indexBytes: big, sigBytes: Buffer.from('{}'), anchors: [], now: 0, expectedId: 'registry:x.y' }),
    (e) => e.code === 'too_large',
  );
  const bigRev = Buffer.alloc(LIMITS.revocations + 1, 0x20);
  assert.throws(
    () => verifyRevocations({ bytes: bigRev, sigBytes: Buffer.from('{}'), anchors: [], now: 0, expectedId: 'registry:x.y' }),
    (e) => e.code === 'too_large',
  );
  const bigDetail = Buffer.alloc(LIMITS.detail + 1, 0x20);
  assert.throws(() => checkDetail({ detail: { size: bigDetail.length, sha256: sha256Of(bigDetail), path: 'apps/a.b.json' }, app_id: 'a.b' }, bigDetail), (e) => e.code === 'too_large');
});

test('the test keys are not trust anchors in any build', () => {
  const trust = readFileSync(join(HERE, '..', '..', '..', 'src-tauri', 'src', 'trust.rs'), 'utf8');
  for (const [name, k] of Object.entries(KEYS)) {
    assert.ok(!trust.includes(k.keyid), `test key "${name}" appears in trust.rs`);
  }
  assert.ok(trust.includes('ed25519:GmNzEGh_57SWBOBLNV7kEnhykqoCkcCCMAnbkh0IVHY'), 'production root still compiled in');
});

test('domain prefixes are distinct and newline terminated', () => {
  const all = [DOMAIN.index, DOMAIN.revocations, DOMAIN.cert, 'sanctum-statement-v1\n'];
  assert.equal(new Set(all).size, all.length);
  for (const d of all) assert.ok(d.endsWith('\n'));
  for (const a of all) for (const b of all) if (a !== b) assert.ok(!b.startsWith(a), `${a} prefixes ${b}`);
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const schemaFiles = readdirSync(join(HERE, '..', 'schema')).filter((f) => f.endsWith('.schema.json'));

test('schemas are valid JSON and every $ref resolves', () => {
  assert.deepEqual(schemaFiles.sort(), [
    'app.schema.json',
    'common.schema.json',
    'index.schema.json',
    'revocations.schema.json',
    'sigfile.schema.json',
  ]);
  const walk = (node, file) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, file));
    if (node && typeof node === 'object') {
      if (typeof node.$ref === 'string') {
        const [f, pointer] = node.$ref.split('#');
        let target = loadSchema(f || file);
        for (const part of pointer.split('/').filter(Boolean)) {
          target = target?.[part];
          assert.ok(target !== undefined, `${file}: unresolved ${node.$ref}`);
        }
      }
      Object.values(node).forEach((n) => walk(n, file));
    }
  };
  for (const f of schemaFiles) walk(loadSchema(f), f);
});

test('schema patterns avoid constructs the Rust regex crate rejects', () => {
  const patterns = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.pattern === 'string') patterns.push(node.pattern);
      Object.values(node).forEach(walk);
    }
  };
  for (const f of schemaFiles) walk(loadSchema(f));
  assert.ok(patterns.length > 10);
  for (const p of patterns) {
    assert.ok(!/\(\?[=!<]/.test(p), `lookaround in ${p}`);
    assert.ok(!/\\[1-9]/.test(p), `backreference in ${p}`);
  }
});

/** Problems the index schema reports when one version's bundle path is `path`. */
function bundlePathProblems(path) {
  const hash = `sha256:${'0'.repeat(64)}`;
  return validate('index.schema.json', {
    format: 'sanctum-registry/1',
    id: 'registry:a.b',
    name: 'n',
    kind: 'public',
    serial: 1,
    issued_at: 1,
    expires: 2,
    apps: [
      {
        app_id: 'a.b',
        name: 'n',
        summary: '',
        publisher: { keyid: `ed25519:${'A'.repeat(43)}`, name: 'p' },
        access: 'free',
        latest: '1',
        detail: { path: 'apps/a.b.json', sha256: hash, size: 5 },
        versions: [
          {
            version: '1',
            published_at: 1,
            bundle: { path, sha256: hash, size: 5 },
            checksum: hash,
            declared: [],
          },
        ],
      },
    ],
  });
}

test('paths accept the good and refuse traversal, absolute URLs and odd characters', () => {
  assert.deepEqual(bundlePathProblems('bundles/a.b-1.sanctum'), []);
  for (const bad of [
    '../a.sanctum',
    '/abs.sanctum',
    'a/../b.sanctum',
    './a.sanctum',
    '.hidden.sanctum',
    'a//b.sanctum',
    'a\\b.sanctum',
    'a%2e%2e/b.sanctum',
    'https://x.test/a.sanctum',
    'a.sanctum?x=1',
    'a.html',
    'a/b/c/d/e/f/g/h.sanctum',
  ]) {
    assert.notDeepEqual(bundlePathProblems(bad), [], `accepted ${bad}`);
  }
});

/** True when `value` satisfies the pattern and length of a named definition in common.schema.json. */
function matchesDef(def, value) {
  const s = loadSchema('common.schema.json').$defs[def];
  return new RegExp(s.pattern, 'u').test(value) && (!s.maxLength || value.length <= s.maxLength);
}

test('ids, versions, hashes and key ids are strict', () => {
  assert.ok(matchesDef('appId', 'sh.enigma.otp-vault'));
  for (const bad of ['sh', 'Sh.enigma.x', 'sh..x', 'sh.enigma.', '-sh.enigma', 'registry:sh.x', 'sh.enigma.x_y']) {
    assert.ok(!matchesDef('appId', bad), `accepted app id ${bad}`);
  }
  assert.ok(matchesDef('registryId', 'registry:sh.enigma.public'));
  for (const bad of ['sh.enigma.public', 'registry:', 'registry:Sh.x', 'registry:sh']) {
    assert.ok(!matchesDef('registryId', bad), bad);
  }
  assert.ok(matchesDef('version', '1.0.2'));
  for (const bad of ['1.0.0.0.0', 'v1', '1.', '1.a', '', '1..2']) assert.ok(!matchesDef('version', bad), bad);
  assert.ok(matchesDef('sha256', `sha256:${'a'.repeat(64)}`));
  for (const bad of [`sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha1:${'a'.repeat(64)}`]) {
    assert.ok(!matchesDef('sha256', bad), bad);
  }
  assert.ok(matchesDef('keyid', KEYS.root.keyid));
  for (const bad of ['ed25519:short', `rsa:${'A'.repeat(43)}`, `ed25519:${'A'.repeat(44)}`]) {
    assert.ok(!matchesDef('keyid', bad), bad);
  }
});

test('a registry id is a different namespace from an app id', () => {
  // A publisher certificate scoped to app ids ("sh.enigma.") must not cover a registry id.
  assert.ok(!'registry:sh.enigma.public'.startsWith('sh.enigma.'));
  const appId = loadSchema('common.schema.json').$defs.appId.pattern;
  assert.ok(!new RegExp(appId).test('registry:sh.enigma.public'));
});
