// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Verifies a registry directory the way a client would, and then some: every referenced file
// is present and matches its hash, every bundle verifies and agrees with the index, and
// nothing unreferenced is left lying around. Used by CI, by sign-registry.sh after signing,
// and by tests.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, relative } from 'node:path';
import { RegistryError, checkAsset, checkDetail, verifyIndex, verifyRevocations } from '../../spec/registry/reference.mjs';
import { imageSize } from './images.mjs';
import { verifyBundle } from './registry.mjs';

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

/**
 * @returns {{ problems: string[], warnings: string[], index?: object }} Empty `problems` means
 * the directory is a valid, signed, anchored, internally consistent registry.
 */
export function verifyRegistryDir({ dir, anchors, now, expectedId, allowStale = false }) {
  const problems = [];
  const warnings = [];
  const read = (rel) => readFileSync(join(dir, rel));
  const fail = (m) => problems.push(m);
  const guard = (label, fn) => {
    try {
      return fn();
    } catch (e) {
      fail(`${label}: ${e instanceof RegistryError ? e.message : e.message}`);
      return undefined;
    }
  };

  for (const f of ['index.json', 'index.json.sig', 'revocations.json', 'revocations.json.sig']) {
    if (!existsSync(join(dir, f))) fail(`${f}: missing${f.endsWith('.sig') ? ' (run scripts/sign-registry.sh)' : ''}`);
  }
  if (problems.length) return { problems, warnings };

  const idx = guard('index.json', () =>
    verifyIndex({ indexBytes: read('index.json'), sigBytes: read('index.json.sig'), anchors, now, expectedId }),
  );
  const rev = guard('revocations.json', () =>
    verifyRevocations({ bytes: read('revocations.json'), sigBytes: read('revocations.json.sig'), anchors, now, expectedId }),
  );
  if (!idx) return { problems, warnings };

  if (idx.trust !== 'anchored') fail(`index.json: signer is not anchored${idx.reason ? ` (${idx.reason})` : ''}`);
  if (idx.stale) (allowStale ? warnings : problems).push('index.json: expired, re-sign it with scripts/sign-registry.sh --renew');
  if (rev) {
    if (rev.trust !== 'anchored') fail(`revocations.json: signer is not anchored${rev.reason ? ` (${rev.reason})` : ''}`);
    if (rev.stale) (allowStale ? warnings : problems).push('revocations.json: expired, re-sign it with scripts/sign-registry.sh --renew');
  }

  const referenced = new Set(['index.json', 'index.json.sig', 'revocations.json', 'revocations.json.sig']);
  const need = (ref, label) => {
    referenced.add(ref.path);
    if (!existsSync(join(dir, ref.path))) {
      fail(`${label}: ${ref.path} is missing`);
      return null;
    }
    return guard(`${label} ${ref.path}`, () => {
      const bytes = read(ref.path);
      checkAsset(ref, bytes);
      return bytes;
    });
  };

  const revokedChecksums = new Set((rev?.revocations.entries ?? []).map((e) => e.checksum));

  for (const app of idx.index.apps) {
    const label = app.app_id;
    // Detail file, then everything it points at.
    referenced.add(app.detail.path);
    let detail;
    if (!existsSync(join(dir, app.detail.path))) fail(`${label}: ${app.detail.path} is missing`);
    else detail = guard(`${label} detail`, () => checkDetail(app, read(app.detail.path)));

    if (app.icon) need(app.icon, `${label} icon`);
    if (detail?.manual) need(detail.manual, `${label} manual`);
    for (const s of detail?.screenshots ?? []) {
      const bytes = need(s, `${label} screenshot`);
      if (!bytes) continue;
      guard(`${label} ${s.path}`, () => {
        const dim = imageSize(bytes);
        if (dim.width !== s.width || dim.height !== s.height) throw new Error(`size is ${dim.width}x${dim.height}, index says ${s.width}x${s.height}`);
        if (!s.path.endsWith(`.${dim.type}`)) throw new Error(`file is a ${dim.type} but the name says otherwise`);
      });
    }

    // Bundles: signed by an anchored key, and exactly what the index says.
    for (const v of app.versions) {
      const bytes = need(v.bundle, `${label} ${v.version} bundle`);
      if (!bytes) continue;
      guard(`${label} ${v.version}`, () => {
        const b = verifyBundle(bytes, anchors, now, `${label} ${v.version}`);
        const s = b.statement;
        const same = s.app_id === app.app_id && s.version === v.version && s.checksum === v.checksum && isDeepStrictEqual(s.declared, v.declared);
        if (!same) throw new Error('the signed statement does not match the index entry (app_id, version, checksum, declared)');
        if (b.signer !== app.publisher.keyid) throw new Error('the bundle signer is not the publisher key listed in the index');
      });
      if (revokedChecksums.has(v.checksum)) fail(`${label} ${v.version}: this version is revoked but still listed`);
    }
  }

  for (const f of listFiles(dir)) if (!referenced.has(f)) fail(`${f}: not referenced by index.json`);
  return { problems, warnings, index: idx.index };
}
