// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Shared setup for the registry build tests: throw-away test keys, the real Rust CLI, and a
// synthetic registry/ source tree. Nothing here touches ~/.sanctum-keys or any real key.

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
const CRATE = join(REPO, 'src-tauri/crates/sanctum-bundle');

export const NOW = 1_800_000_000;
export const REGISTRY_ID = 'registry:sh.test.public';

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function testKey(label) {
  const seed = createHash('sha256').update(`sanctum-build-test-key:${label}`).digest();
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  const keyid = `ed25519:${Buffer.from(spki.subarray(spki.length - 32)).toString('base64url')}`;
  return { seed, keyid };
}

let built = false;
/** Build the CLI once and return its path. */
export function cliPath() {
  const bin = join(CRATE, 'target/debug/sanctum-bundle');
  if (!built) {
    const r = spawnSync('cargo', ['build', '-q', '--manifest-path', join(CRATE, 'Cargo.toml')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cargo build failed:\n${r.stderr}`);
    built = true;
  }
  return bin;
}

export function cli(...args) {
  const r = spawnSync(cliPath(), args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function cliOk(...args) {
  const r = cli(...args);
  if (r.status !== 0) throw new Error(`sanctum-bundle ${args[0]} failed: ${r.stderr}`);
  return r;
}

/** A fresh scratch directory. */
export function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'sanctum-registry-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230A0A0A'/%3E%3C/svg%3E";

export function toolHtml(name, extra = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><link rel="icon" href="${ICON}"></head><body><p>${name} ${extra}</p></body></html>`;
}

/**
 * A complete synthetic world: root, publisher and registry keys with certificates, two signed
 * bundles, and a registry/ source tree. Returns paths and the anchors to verify against.
 */
export function makeWorld({ apps = ['alpha', 'beta'] } = {}) {
  const { dir, cleanup } = scratch();
  const keys = { root: testKey('root'), publisher: testKey('publisher'), registry: testKey('registry'), rogue: testKey('rogue') };
  const keyDir = join(dir, 'keys');
  mkdirSync(keyDir);
  const keyFile = (name) => {
    const p = join(keyDir, `${name}.key`);
    writeFileSync(p, JSON.stringify({ secret: keys[name].seed.toString('base64url'), keyid: keys[name].keyid }));
    return p;
  };
  const files = Object.fromEntries(Object.keys(keys).map((k) => [k, keyFile(k)]));

  const cert = (name, issuer, subject, scope) => {
    const out = join(keyDir, `${name}.cert.json`);
    cliOk('cert', '--issuer', files[issuer], '--subject', keys[subject].keyid, '--name', 'Test Publisher', '--not-before', String(NOW - 100_000), '--not-after', String(NOW + 100_000_000), '--scope', scope, '--out', out);
    return out;
  };
  const certs = {
    publisher: cert('publisher', 'root', 'publisher', 'sh.test.'),
    registry: cert('registry', 'root', 'registry', 'registry:sh.test.'),
    // Valid certificate, but for apps only. Must not be accepted for signing a registry.
    publisherAsRegistry: cert('publisher-apps-only', 'root', 'publisher', 'sh.test.'),
    rogue: cert('rogue', 'rogue', 'rogue', 'sh.test.'),
  };

  const source = join(dir, 'registry');
  const bundles = join(dir, 'bundles');
  mkdirSync(join(source, 'apps'), { recursive: true });
  mkdirSync(bundles);
  writeFileSync(
    join(source, 'registry.json'),
    JSON.stringify({ id: REGISTRY_ID, name: 'Test Publisher', kind: 'public', site_url: 'https://example.test', index_days: 90, revocations_days: 14 }, null, 2),
  );
  writeFileSync(join(source, 'revocations.json'), JSON.stringify({ entries: [] }));

  const declared = join(dir, 'declared.json');
  writeFileSync(declared, '["storage"]');

  const signBundle = ({ app, version, signer = 'publisher', cert: c = 'publisher', html, name, into = bundles }) => {
    const appId = `sh.test.${app}`;
    const htmlPath = join(dir, `${app}-${version}.html`);
    writeFileSync(htmlPath, html ?? toolHtml(app, version));
    const out = join(into, `${appId}-${version}.sanctum`);
    mkdirSync(into, { recursive: true });
    cliOk('sign', '--key', files[signer], '--html', htmlPath, '--app-id', appId, '--name', name ?? `Tool ${app}`, '--version', version, '--declared', declared, '--cert', certs[c], '--issued-at', String(NOW - 5000), '--out', out);
    return out;
  };

  const writeApp = (app, over = {}) => {
    const appId = `sh.test.${app}`;
    const d = join(source, 'apps', appId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'app.json'), JSON.stringify({ app_id: appId, summary: `${app} summary`, description: `${app} description`, license: 'AGPL-3.0-only', ...over }, null, 2));
    writeFileSync(join(d, 'CHANGELOG.md'), '# Changelog\n\n## 1.0.0 (2027-01-14)\n- added: First release.\n');
    writeFileSync(join(d, 'manual.md'), '## Use it\n\nPress **Go**.\n');
    return d;
  };

  for (const a of apps) {
    signBundle({ app: a, version: '1.0.0' });
    writeApp(a);
  }

  const out = join(dir, 'out', 'registry', 'v1');
  const anchors = [{ keyid: keys.root.keyid, name: 'Test Root' }];
  const sign = (file, kind, { key = 'registry', cert: c = 'registry' } = {}) => {
    const sig = `${file}.sig`;
    if (existsSync(sig)) rmSync(sig);
    return cli('registry-sign', '--kind', kind, '--key', files[key], '--file', file, '--cert', certs[c], '--out', sig);
  };
  // Signs whichever of the two files has no signature yet. The CLI never overwrites one,
  // and the builder removes the signature of any file it changed.
  const signAll = () => {
    for (const [kind, file] of [['index', 'index.json'], ['revocations', 'revocations.json']]) {
      if (existsSync(join(out, `${file}.sig`))) continue;
      cliOk('registry-sign', '--kind', kind, '--key', files.registry, '--file', join(out, file), '--cert', certs.registry, '--out', join(out, `${file}.sig`));
    }
  };

  return {
    dir, cleanup, keys, files, certs, source, bundles, out, anchors, sign, signAll, signBundle, writeApp,
    copy: (to) => cpSync(out, to, { recursive: true }),
  };
}
