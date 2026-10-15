#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Generates spec/registry/vectors: signed registry files and the verdict each one must get.
//
//   node spec/registry/make-vectors.mjs          write the vectors
//   node spec/registry/make-vectors.mjs --check  fail if the committed vectors are stale
//
// TEST KEYS ONLY. Every key here is derived from a public string, so anyone can recompute
// the private halves. None of them is, or may ever be, a trust anchor in a Sanctum build:
// test/vectors.test.mjs fails if one appears in src-tauri/src/trust.rs. Production keys are
// made and kept by the maintainer and never touch this script.
//
// Ed25519 signatures are deterministic, so the output is byte-for-byte reproducible.

import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAIN, sha256Of } from './reference.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const VECTOR_DIR = join(HERE, 'vectors');

export const NOW = 1_790_000_000;
export const REGISTRY_ID = 'registry:sh.enigma.test';
const DAY = 86_400;

// ── Test keys ─────────────────────────────────────────────────────────────────

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function testKey(label) {
  const seed = createHash('sha256').update(`sanctum-registry-test-key:${label}`).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const keyid = `ed25519:${Buffer.from(spki.subarray(spki.length - 32)).toString('base64url')}`;
  return { priv, keyid };
}

export const KEYS = {
  root: { ...testKey('root'), name: 'Test Root' },
  publisher: { ...testKey('publisher'), name: 'Test Publisher' },
  other: { ...testKey('other'), name: 'Test Other' },
};

function signBytes(domain, bytes, key) {
  return sign(null, Buffer.concat([Buffer.from(domain, 'utf8'), bytes]), key.priv).toString('base64url');
}

function certBlob(issuer, subject, over = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      schema: 1,
      subject: subject.keyid,
      name: subject.name,
      not_before: NOW - 10_000,
      not_after: NOW + 10_000_000,
      scope: ['registry:sh.enigma.'],
      ...over,
    }),
  );
  return { payload: payload.toString('base64url'), sig: signBytes(DOMAIN.cert, payload, issuer), keyid: issuer.keyid };
}

function sigFile(domain, bytes, signer, chain) {
  const doc = { format: 'sanctum-registry-sig/1', keyid: signer.keyid, sig: signBytes(domain, bytes, signer) };
  if (chain) doc.chain = chain;
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
}

// ── Base documents ────────────────────────────────────────────────────────────

const json = (o) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);
const fakeHash = (s) => sha256Of(Buffer.from(s));

function detailDoc(appId, over = {}) {
  return {
    format: 'sanctum-registry-app/1',
    app_id: appId,
    description: 'A test description. Plain text only.',
    license: 'AGPL-3.0-only',
    changelog: [
      {
        version: '1.0.0',
        date: '2026-09-30',
        changes: [{ type: 'added', text: 'First release.' }],
      },
    ],
    ...over,
  };
}

const APPS = [
  { id: 'sh.enigma.otp-vault', name: 'OTP Vault', version: '1.0.0' },
  { id: 'sh.enigma.shamir', name: 'Shamir Secret Sharing', version: '1.0.2' },
];

/** Shared asset bytes referenced by the base index. */
function baseAssets() {
  const out = new Map();
  for (const a of APPS) {
    out.set(`apps/${a.id}.json`, json(detailDoc(a.id)));
    out.set(`bundles/${a.id}-${a.version}.sanctum`, Buffer.from(`test bundle for ${a.id} ${a.version}\n`));
  }
  return out;
}

function appEntry(a, assets, over = {}) {
  const detail = assets.get(`apps/${a.id}.json`);
  const bundle = assets.get(`bundles/${a.id}-${a.version}.sanctum`);
  return {
    app_id: a.id,
    name: a.name,
    summary: `${a.name}, a test entry.`,
    publisher: { keyid: KEYS.publisher.keyid, name: KEYS.publisher.name },
    access: 'free',
    latest: a.version,
    detail: { path: `apps/${a.id}.json`, sha256: sha256Of(detail), size: detail.length },
    versions: [
      {
        version: a.version,
        published_at: NOW - 5000,
        bundle: { path: `bundles/${a.id}-${a.version}.sanctum`, sha256: sha256Of(bundle), size: bundle.length },
        checksum: fakeHash(`tool ${a.id} ${a.version}`),
        declared: ['storage'],
      },
    ],
    ...over,
  };
}

function baseIndex(assets, over = {}) {
  return {
    format: 'sanctum-registry/1',
    id: REGISTRY_ID,
    name: 'Test Registry',
    kind: 'public',
    serial: 7,
    issued_at: NOW - 1000,
    expires: NOW + 90 * DAY,
    mirrors: ['https://mirror.test/registry/v1/'],
    revocations: 'revocations.json',
    apps: APPS.map((a) => appEntry(a, assets)),
    ...over,
  };
}

function baseRevocations(over = {}) {
  return {
    format: 'sanctum-registry-revocations/1',
    registry: REGISTRY_ID,
    serial: 3,
    issued_at: NOW - 500,
    expires: NOW + 14 * DAY,
    entries: [
      {
        checksum: fakeHash('tool sh.enigma.otp-vault 1.0.0'),
        app_id: 'sh.enigma.otp-vault',
        version: '1.0.0',
        reason: 'vulnerable',
        note: 'Test entry.',
        revoked_at: NOW - 600,
      },
    ],
    ...over,
  };
}

// ── Cases ─────────────────────────────────────────────────────────────────────

export function buildVectors() {
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  const cases = [];
  const assets = baseAssets();
  for (const [p, b] of assets) files.set(`assets/${p}`, b);

  const anchorsRoot = ['root'];

  function indexCase(name, spec) {
    const {
      doc = baseIndex(assets),
      raw,
      signer = KEYS.root,
      chain,
      domain = DOMAIN.index,
      tamper,
      sigRaw,
      sigExtra,
      anchors = anchorsRoot,
      now = NOW,
      expectedId = REGISTRY_ID,
      lastSeen,
      expect,
    } = spec;
    let bytes = raw ?? json(doc);
    let sig = sigRaw ?? sigFile(domain, bytes, signer, chain);
    if (sigExtra) sig = Buffer.from(`${JSON.stringify({ ...JSON.parse(sig.toString('utf8')), ...sigExtra }, null, 2)}\n`);
    if (tamper) bytes = Buffer.from(tamper(bytes.toString('utf8')));
    files.set(`${name}/index.json`, bytes);
    files.set(`${name}/index.json.sig`, sig);
    const c = {
      name,
      kind: 'index',
      index: `${name}/index.json`,
      sig: `${name}/index.json.sig`,
      now,
      anchors,
      expected_id: expectedId,
      expect,
    };
    if (lastSeen) c.last_seen = typeof lastSeen === 'function' ? lastSeen(bytes) : lastSeen;
    cases.push(c);
  }

  const ok = (trust, publisher, extra = {}) => ({ result: 'ok', trust, publisher, stale: false, ...extra });
  const err = (error) => ({ result: 'error', error });

  indexCase('index_root_signed', { expect: ok('anchored', 'Test Root') });
  indexCase('index_chain_signed', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher)],
    expect: ok('anchored', 'Test Publisher'),
  });
  indexCase('index_unanchored_no_chain', {
    signer: KEYS.other,
    expect: { result: 'ok', trust: 'unanchored', reason: null, stale: false },
  });
  indexCase('index_unanchored_app_scope_only', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher, { scope: ['sh.enigma.'] })],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate does not cover this registry', stale: false },
  });
  indexCase('index_unanchored_cert_empty_scope_entry', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher, { scope: [''] })],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate does not cover this registry', stale: false },
  });
  indexCase('index_unanchored_cert_empty_scope_list', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher, { scope: [] })],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate does not cover this registry', stale: false },
  });
  indexCase('index_chain_scope_second_entry_ok', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher, { scope: ['sh.other.', 'registry:sh.enigma.'] })],
    expect: ok('anchored', 'Test Publisher'),
  });
  indexCase('index_unanchored_cert_expired', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher, { not_after: NOW - 1 })],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate has expired', stale: false },
  });
  indexCase('index_unanchored_cert_not_yet_valid', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher, { not_before: NOW + 100 })],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate is not yet valid', stale: false },
  });
  indexCase('index_unanchored_cert_wrong_issuer', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.other, KEYS.publisher)],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate was not issued by a trusted key', stale: false },
  });
  indexCase('index_unanchored_cert_other_subject', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.other)],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate is for a different key', stale: false },
  });
  indexCase('index_unanchored_cert_extra_field', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher, { extra: 1 })],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate is malformed', stale: false },
  });
  indexCase('index_unanchored_chain_too_long', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher), certBlob(KEYS.root, KEYS.publisher)],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate chains longer than one are not supported', stale: false },
  });
  indexCase('index_unanchored_cert_bad_signature', {
    signer: KEYS.publisher,
    chain: [{ ...certBlob(KEYS.root, KEYS.publisher), sig: certBlob(KEYS.root, KEYS.other).sig }],
    expect: { result: 'ok', trust: 'unanchored', reason: 'certificate signature does not verify', stale: false },
  });
  indexCase('index_sig_unknown_fields_ok', {
    sigExtra: { future: [1, 2] },
    expect: ok('anchored', 'Test Root'),
  });
  indexCase('index_bom_rejected', {
    raw: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json(baseIndex(assets))]),
    expect: err('malformed_json'),
  });
  indexCase('index_not_an_object', { raw: Buffer.from('[]\n'), expect: err('schema_invalid') });
  indexCase('index_integer_written_as_float_ok', {
    raw: Buffer.from(json(baseIndex(assets)).toString('utf8').replace('"serial": 7,', '"serial": 7.0,')),
    expect: ok('anchored', 'Test Root'),
  });
  indexCase('index_serial_is_a_string', {
    raw: Buffer.from(json(baseIndex(assets)).toString('utf8').replace('"serial": 7,', '"serial": "7",')),
    expect: err('schema_invalid'),
  });
  indexCase('index_stale', {
    now: NOW + 91 * DAY,
    expect: ok('anchored', 'Test Root', { stale: true }),
  });
  indexCase('index_bad_signature_tampered', {
    tamper: (s) => s.replace('Test Registry', 'Test Registrx'),
    expect: err('bad_signature'),
  });
  indexCase('index_bad_signature_wrong_domain', {
    domain: 'sanctum-statement-v1\n',
    expect: err('bad_signature'),
  });
  indexCase('index_bad_signature_revocations_domain', {
    domain: DOMAIN.revocations,
    expect: err('bad_signature'),
  });
  indexCase('index_sig_malformed', { sigRaw: Buffer.from('not json'), expect: err('sig_malformed') });
  indexCase('index_malformed_json', { raw: Buffer.from('{"format": '), expect: err('malformed_json') });
  indexCase('index_format_unsupported', {
    doc: baseIndex(assets, { format: 'sanctum-registry/2' }),
    expect: err('format_unsupported'),
  });
  indexCase('index_unknown_fields_ok', {
    doc: (() => {
      const d = baseIndex(assets, { future_field: { anything: [1, 2, 3] } });
      d.apps[0].future_app_field = 'ignored';
      d.apps[0].versions[0].future_version_field = true;
      return d;
    })(),
    expect: ok('anchored', 'Test Root'),
  });
  indexCase('index_licensed_listed_ok', {
    doc: (() => {
      const d = baseIndex(assets, { kind: 'licensed' });
      d.apps[1].access = 'licensed';
      return d;
    })(),
    expect: ok('anchored', 'Test Root'),
  });
  indexCase('index_attestation_parsed_ok', {
    doc: (() => {
      const d = baseIndex(assets);
      d.apps[0].versions[0].attestations = [
        {
          kind: 'review',
          keyid: KEYS.other.keyid,
          sig: signBytes('sanctum-attestation-v1\n', Buffer.from('x'), KEYS.other),
          issued_at: NOW - 100,
          report: { path: 'reports/otp-vault-1.0.0.md', sha256: fakeHash('report'), size: 6 },
        },
      ];
      return d;
    })(),
    expect: ok('anchored', 'Test Root'),
  });
  indexCase('index_schema_missing_apps', {
    doc: (() => {
      const d = baseIndex(assets);
      delete d.apps;
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  indexCase('index_schema_bad_checksum', {
    doc: (() => {
      const d = baseIndex(assets);
      d.apps[0].versions[0].checksum = 'sha256:XYZ';
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  indexCase('index_schema_bad_id', {
    doc: baseIndex(assets, { id: 'sh.enigma.test' }),
    expect: err('schema_invalid'),
  });
  indexCase('index_schema_duplicate_app', {
    doc: (() => {
      const d = baseIndex(assets);
      d.apps.push(structuredClone(d.apps[0]));
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  indexCase('index_schema_latest_missing', {
    doc: (() => {
      const d = baseIndex(assets);
      d.apps[0].latest = '9.9.9';
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  indexCase('index_schema_expires_before_issued', {
    doc: baseIndex(assets, { expires: NOW - 5000 }),
    expect: err('schema_invalid'),
  });
  indexCase('index_path_traversal', {
    doc: (() => {
      const d = baseIndex(assets);
      d.apps[0].versions[0].bundle.path = '../outside.sanctum';
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  indexCase('index_path_absolute_url', {
    doc: (() => {
      const d = baseIndex(assets);
      d.apps[0].versions[0].bundle.path = 'https://evil.test/x.sanctum';
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  indexCase('index_path_not_canonical', {
    doc: (() => {
      const d = baseIndex(assets);
      d.apps[0].versions[0].bundle.path = 'bundles/elsewhere.sanctum';
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  indexCase('index_id_mismatch', { expectedId: 'registry:sh.enigma.other', expect: err('id_mismatch') });
  indexCase('index_from_future', {
    doc: baseIndex(assets, { issued_at: NOW + 3 * DAY, expires: NOW + 90 * DAY }),
    expect: err('from_future'),
  });
  indexCase('index_rollback', {
    lastSeen: { serial: 8, sha256: fakeHash('previous') },
    expect: err('rollback'),
  });
  indexCase('index_serial_replay', {
    lastSeen: { serial: 7, sha256: fakeHash('different bytes') },
    expect: err('serial_replay'),
  });
  indexCase('index_same_serial_same_bytes_ok', {
    lastSeen: (bytes) => ({ serial: 7, sha256: sha256Of(bytes) }),
    expect: ok('anchored', 'Test Root'),
  });
  indexCase('index_newer_serial_ok', {
    lastSeen: { serial: 6, sha256: fakeHash('older') },
    expect: ok('anchored', 'Test Root'),
  });

  // Revocations
  function revCase(name, spec) {
    const { doc = baseRevocations(), raw, signer = KEYS.root, chain, domain = DOMAIN.revocations, tamper, now = NOW, expectedId = REGISTRY_ID, lastSeen, expect } = spec;
    let bytes = raw ?? json(doc);
    const sig = sigFile(domain, bytes, signer, chain);
    if (tamper) bytes = Buffer.from(tamper(bytes.toString('utf8')));
    files.set(`${name}/revocations.json`, bytes);
    files.set(`${name}/revocations.json.sig`, sig);
    const c = {
      name,
      kind: 'revocations',
      file: `${name}/revocations.json`,
      sig: `${name}/revocations.json.sig`,
      now,
      anchors: anchorsRoot,
      expected_id: expectedId,
      expect,
    };
    if (lastSeen) c.last_seen = lastSeen;
    cases.push(c);
  }
  revCase('revocations_ok', { expect: ok('anchored', 'Test Root') });
  revCase('revocations_chain_ok', {
    signer: KEYS.publisher,
    chain: [certBlob(KEYS.root, KEYS.publisher)],
    expect: ok('anchored', 'Test Publisher'),
  });
  revCase('revocations_empty_ok', { doc: baseRevocations({ entries: [] }), expect: ok('anchored', 'Test Root') });
  revCase('revocations_stale', { now: NOW + 15 * DAY, expect: ok('anchored', 'Test Root', { stale: true }) });
  revCase('revocations_bad_signature', { tamper: (s) => s.replace('vulnerable', 'withdrawn'), expect: err('bad_signature') });
  revCase('revocations_index_domain', { domain: DOMAIN.index, expect: err('bad_signature') });
  revCase('revocations_registry_mismatch', { doc: baseRevocations({ registry: 'registry:sh.enigma.other' }), expect: err('id_mismatch') });
  revCase('revocations_rollback', { lastSeen: { serial: 4, sha256: fakeHash('x') }, expect: err('rollback') });
  revCase('revocations_duplicate_checksum', {
    doc: (() => {
      const d = baseRevocations();
      d.entries.push(structuredClone(d.entries[0]));
      return d;
    })(),
    expect: err('schema_invalid'),
  });
  revCase('revocations_bad_reason', {
    doc: (() => {
      const d = baseRevocations();
      d.entries[0].reason = 'because';
      return d;
    })(),
    expect: err('schema_invalid'),
  });

  // Assets: bytes fetched later are checked against their index entry.
  const index = baseIndex(assets);
  const otp = index.apps[0];
  const detailBytes = assets.get(`apps/${otp.app_id}.json`);
  const bundleBytes = assets.get(`bundles/${otp.app_id}-1.0.0.sanctum`);

  function assetCase(name, spec) {
    const { entry, bytes, kind = 'asset', expect } = spec;
    files.set(`${name}/file`, bytes);
    cases.push({ name, kind, entry, file: `${name}/file`, expect });
  }
  assetCase('asset_bundle_ok', { entry: otp.versions[0].bundle, bytes: bundleBytes, expect: { result: 'ok' } });
  assetCase('asset_bundle_hash_mismatch', {
    entry: otp.versions[0].bundle,
    bytes: Buffer.from(bundleBytes.toString().replace('test', 'tent')),
    expect: err('hash_mismatch'),
  });
  assetCase('asset_bundle_size_mismatch', {
    entry: otp.versions[0].bundle,
    bytes: Buffer.concat([bundleBytes, Buffer.from('x')]),
    expect: err('size_mismatch'),
  });
  assetCase('detail_ok', { kind: 'detail', entry: otp, bytes: detailBytes, expect: { result: 'ok' } });
  assetCase('detail_hash_mismatch', {
    kind: 'detail',
    entry: otp,
    bytes: Buffer.from(detailBytes.toString().replace('test', 'tent')),
    expect: err('hash_mismatch'),
  });
  const wrongApp = json(detailDoc('sh.enigma.shamir'));
  assetCase('detail_app_id_mismatch', {
    kind: 'detail',
    entry: { ...otp, detail: { ...otp.detail, sha256: sha256Of(wrongApp), size: wrongApp.length } },
    bytes: wrongApp,
    expect: err('id_mismatch'),
  });
  const badDetail = json(detailDoc(otp.app_id, { changelog: [{ version: '1.0.0', date: 'yesterday', changes: [] }] }));
  assetCase('detail_schema_invalid', {
    kind: 'detail',
    entry: { ...otp, detail: { ...otp.detail, sha256: sha256Of(badDetail), size: badDetail.length } },
    bytes: badDetail,
    expect: err('schema_invalid'),
  });

  const manifest = {
    format: 'sanctum-registry-vectors/1',
    note: 'TEST KEYS ONLY. Derived from public strings. Never a trust anchor in any build.',
    keys: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, { keyid: v.keyid, name: v.name }])),
    cases,
  };
  files.set('vectors.json', json(manifest));
  return files;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(relative(VECTOR_DIR, p));
  }
  return out.sort();
}

/** Differences between a freshly generated set and what is on disk. Empty means in sync. */
export function diffAgainstDisk(files) {
  const problems = [];
  let onDisk = [];
  try {
    onDisk = listFiles(VECTOR_DIR);
  } catch {
    onDisk = [];
  }
  for (const [p, bytes] of files) {
    let existing;
    try {
      existing = readFileSync(join(VECTOR_DIR, p));
    } catch {
      problems.push(`missing: ${p}`);
      continue;
    }
    if (!existing.equals(bytes)) problems.push(`changed: ${p}`);
  }
  for (const p of onDisk) if (!files.has(p)) problems.push(`stale: ${p}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = buildVectors();
  if (process.argv.includes('--check')) {
    const problems = diffAgainstDisk(files);
    if (problems.length) {
      console.error(`Vectors are out of date:\n  ${problems.join('\n  ')}\nRun: node spec/registry/make-vectors.mjs`);
      process.exit(1);
    }
    console.log(`${files.size} vector files in sync.`);
  } else {
    rmSync(VECTOR_DIR, { recursive: true, force: true });
    for (const [p, bytes] of files) {
      const dest = join(VECTOR_DIR, p);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, bytes);
    }
    console.log(`Wrote ${files.size} files to ${relative(process.cwd(), VECTOR_DIR)}`);
  }
}
