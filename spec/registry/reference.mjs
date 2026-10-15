// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Reference implementation of the registry format in docs/registry-format.md.
//
// This is the executable form of the spec. The Rust client (Phase 3) must give the same
// verdict as this module on every file in spec/registry/vectors. Zero dependencies.

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FORMATS = {
  index: 'sanctum-registry/1',
  app: 'sanctum-registry-app/1',
  revocations: 'sanctum-registry-revocations/1',
  sig: 'sanctum-registry-sig/1',
};

/** Domain prefixes. A signature made for one purpose never verifies as another. */
export const DOMAIN = {
  index: 'sanctum-registry-index-v1\n',
  revocations: 'sanctum-registry-revocations-v1\n',
  cert: 'sanctum-publisher-cert-v1\n', // shared with bundle certificates
};

export const LIMITS = {
  index: 2 * 1024 * 1024,
  revocations: 256 * 1024,
  detail: 256 * 1024,
  sigfile: 16 * 1024,
  /** How far in the future `issued_at` may be before the file is refused (clock skew). */
  skewSeconds: 24 * 60 * 60,
};

/** A verification failure with a stable code. Codes are part of the spec. */
export class RegistryError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

// ── Mini JSON Schema validator ────────────────────────────────────────────────
// Supports exactly the keywords the schemas in ./schema use. Unknown properties are allowed.

const SCHEMA_DIR = join(HERE, 'schema');
const schemaCache = new Map();

export function loadSchema(file) {
  if (!schemaCache.has(file)) {
    schemaCache.set(file, JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')));
  }
  return schemaCache.get(file);
}

function resolveRef(ref, currentFile) {
  const [file, pointer] = ref.includes('#') ? ref.split('#') : [ref, ''];
  const doc = loadSchema(file || currentFile);
  let node = doc;
  for (const part of pointer.split('/').filter(Boolean)) node = node[part];
  return { schema: node, file: file || currentFile };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function check(schema, value, path, file, errors) {
  if (schema.$ref) {
    const r = resolveRef(schema.$ref, file);
    return check(r.schema, value, path, r.file, errors);
  }
  const t = typeOf(value);
  if (schema.type) {
    const ok =
      schema.type === 'integer'
        ? Number.isInteger(value)
        : schema.type === 'number'
          ? t === 'number'
          : t === schema.type;
    if (!ok) {
      errors.push(`${path}: expected ${schema.type}`);
      return;
    }
  }
  if ('const' in schema && value !== schema.const) errors.push(`${path}: must be ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: not an allowed value`);
  if (t === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${path}: too long`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: bad format`);
  }
  if (t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`, file, errors));
  }
  if (t === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: missing`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) check(sub, value[key], `${path}.${key}`, file, errors);
    }
  }
}

/** Returns a list of problems; empty means valid. */
export function validate(schemaFile, value) {
  const errors = [];
  check(loadSchema(schemaFile), value, '$', schemaFile, errors);
  return errors;
}

// ── Encoding and keys ─────────────────────────────────────────────────────────

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function decodeB64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new RegistryError('sig_malformed', 'not base64url');
  const buf = Buffer.from(s, 'base64url');
  if (buf.toString('base64url') !== s) throw new RegistryError('sig_malformed', 'not canonical base64url');
  return buf;
}

export function sha256Of(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function publicKeyFromId(keyid) {
  if (typeof keyid !== 'string' || !keyid.startsWith('ed25519:')) throw new RegistryError('sig_malformed', 'bad key id');
  const raw = decodeB64u(keyid.slice('ed25519:'.length));
  if (raw.length !== 32) throw new RegistryError('sig_malformed', 'key id is not 32 bytes');
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    throw new RegistryError('sig_malformed', 'not a valid Ed25519 key');
  }
}

/** True when `sig` is a valid Ed25519 signature by `keyid` over `domain || bytes`. */
export function verifyDomain(domain, bytes, sig, keyid) {
  const key = publicKeyFromId(keyid);
  const raw = decodeB64u(sig);
  if (raw.length !== 64) throw new RegistryError('sig_malformed', 'signature is not 64 bytes');
  return edVerify(null, Buffer.concat([Buffer.from(domain, 'utf8'), bytes]), key, raw);
}

function parseJson(bytes, what) {
  // A byte order mark is not part of JSON. TextDecoder would silently drop it, and a strict
  // parser would refuse it, so refuse it everywhere.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new RegistryError('malformed_json', `${what} starts with a byte order mark`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RegistryError('malformed_json', `${what} is not UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RegistryError('malformed_json', `${what} is not JSON`);
  }
}

// ── Signatures and trust ──────────────────────────────────────────────────────

/** Verify the detached signature over the exact file bytes. Returns the parsed sig file. */
function verifyDetached(domain, fileBytes, sigBytes) {
  if (sigBytes.length > LIMITS.sigfile) throw new RegistryError('too_large', 'signature file');
  let sigDoc;
  try {
    sigDoc = parseJson(sigBytes, 'signature file');
  } catch {
    throw new RegistryError('sig_malformed', 'signature file is not JSON');
  }
  const problems = validate('sigfile.schema.json', sigDoc);
  if (problems.length) throw new RegistryError('sig_malformed', problems[0]);
  if (!verifyDomain(domain, fileBytes, sigDoc.sig, sigDoc.keyid)) throw new RegistryError('bad_signature');
  return sigDoc;
}

/**
 * Decide whether the signer is anchored for `subject` (the registry id).
 * `anchors` is `[{ keyid, name }]`. Mirrors the bundle rules: the signer is an anchor, or
 * `chain[0]` is a valid certificate issued by an anchor whose scope covers the registry id.
 */
export function trustOf(sigDoc, subject, anchors, now) {
  const direct = anchors.find((a) => a.keyid === sigDoc.keyid);
  if (direct) return { trust: 'anchored', publisher: direct.name };
  const chain = sigDoc.chain ?? [];
  if (chain.length === 0) return { trust: 'unanchored', reason: null };
  if (chain.length > 1) return { trust: 'unanchored', reason: 'certificate chains longer than one are not supported' };
  const cert = chain[0];
  const issuer = anchors.find((a) => a.keyid === cert.keyid);
  if (!issuer) return { trust: 'unanchored', reason: 'certificate was not issued by a trusted key' };
  let payload;
  try {
    const bytes = decodeB64u(cert.payload);
    if (!verifyDomain(DOMAIN.cert, bytes, cert.sig, cert.keyid)) {
      return { trust: 'unanchored', reason: 'certificate signature does not verify' };
    }
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { trust: 'unanchored', reason: 'certificate is malformed' };
  }
  if (!isCertificateShape(payload)) return { trust: 'unanchored', reason: 'certificate is malformed' };
  if (payload.schema !== 1) return { trust: 'unanchored', reason: 'certificate has an unsupported schema' };
  if (payload.subject !== sigDoc.keyid) return { trust: 'unanchored', reason: 'certificate is for a different key' };
  if (now < payload.not_before) return { trust: 'unanchored', reason: 'certificate is not yet valid' };
  if (now > payload.not_after) return { trust: 'unanchored', reason: 'certificate has expired' };
  const covers = (payload.scope ?? []).some((p) => typeof p === 'string' && p !== '' && subject.startsWith(p));
  if (!covers) return { trust: 'unanchored', reason: 'certificate does not cover this registry' };
  return { trust: 'anchored', publisher: payload.name };
}

/** A certificate has exactly these fields with these types (same as the bundle format). */
function isCertificateShape(p) {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
  if (Object.keys(p).sort().join() !== 'name,not_after,not_before,schema,scope,subject') return false;
  return (
    Number.isInteger(p.schema) &&
    typeof p.subject === 'string' &&
    typeof p.name === 'string' &&
    Number.isInteger(p.not_before) &&
    Number.isInteger(p.not_after) &&
    Array.isArray(p.scope) &&
    p.scope.every((x) => typeof x === 'string')
  );
}

// ── Rules beyond the schema ───────────────────────────────────────────────────

function semanticIndexProblems(index) {
  const problems = [];
  if (index.expires <= index.issued_at) problems.push('expires must be after issued_at');
  const ids = new Set();
  for (const app of index.apps) {
    if (ids.has(app.app_id)) problems.push(`duplicate app_id ${app.app_id}`);
    ids.add(app.app_id);
    const versions = new Set();
    for (const v of app.versions) {
      if (versions.has(v.version)) problems.push(`${app.app_id}: duplicate version ${v.version}`);
      versions.add(v.version);
      if (v.bundle.path !== `bundles/${app.app_id}-${v.version}.sanctum`) {
        problems.push(`${app.app_id} ${v.version}: bundle path must be bundles/<app_id>-<version>.sanctum`);
      }
    }
    if (!versions.has(app.latest)) problems.push(`${app.app_id}: latest ${app.latest} is not in versions`);
    if (app.detail.path !== `apps/${app.app_id}.json`) {
      problems.push(`${app.app_id}: detail path must be apps/<app_id>.json`);
    }
  }
  return problems;
}

function semanticRevocationProblems(doc) {
  const problems = [];
  if (doc.expires <= doc.issued_at) problems.push('expires must be after issued_at');
  const seen = new Set();
  for (const e of doc.entries) {
    if (seen.has(e.checksum)) problems.push(`duplicate checksum ${e.checksum}`);
    seen.add(e.checksum);
  }
  return problems;
}

function parseAndCheck(bytes, what, schemaFile, formatKey, semantic) {
  const doc = parseJson(bytes, what);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new RegistryError('schema_invalid', `${what} is not an object`);
  }
  if (typeof doc.format === 'string' && doc.format !== FORMATS[formatKey]) {
    throw new RegistryError('format_unsupported', doc.format);
  }
  const problems = validate(schemaFile, doc);
  if (problems.length) throw new RegistryError('schema_invalid', problems[0]);
  const rules = semantic(doc);
  if (rules.length) throw new RegistryError('schema_invalid', rules[0]);
  return doc;
}

// ── Top-level checks ──────────────────────────────────────────────────────────

/**
 * Check a signed `index.json`. `lastSeen` is `{ serial, sha256 }` of the newest accepted
 * index for this registry, or null. Throws `RegistryError`; on success returns the verdict.
 */
export function verifyIndex({ indexBytes, sigBytes, anchors, now, expectedId, lastSeen = null }) {
  if (indexBytes.length > LIMITS.index) throw new RegistryError('too_large', 'index.json');
  const sigDoc = verifyDetached(DOMAIN.index, indexBytes, sigBytes);
  const index = parseAndCheck(indexBytes, 'index.json', 'index.schema.json', 'index', semanticIndexProblems);
  if (index.id !== expectedId) throw new RegistryError('id_mismatch', index.id);
  if (index.issued_at > now + LIMITS.skewSeconds) throw new RegistryError('from_future');
  applyRollbackRule(index.serial, sha256Of(indexBytes), lastSeen);
  return {
    index,
    signer: sigDoc.keyid,
    ...trustOf(sigDoc, index.id, anchors, now),
    stale: now > index.expires,
  };
}

/** Same checks for `revocations.json`; `registry` must match the index id. */
export function verifyRevocations({ bytes, sigBytes, anchors, now, expectedId, lastSeen = null }) {
  if (bytes.length > LIMITS.revocations) throw new RegistryError('too_large', 'revocations.json');
  const sigDoc = verifyDetached(DOMAIN.revocations, bytes, sigBytes);
  const doc = parseAndCheck(bytes, 'revocations.json', 'revocations.schema.json', 'revocations', semanticRevocationProblems);
  if (doc.registry !== expectedId) throw new RegistryError('id_mismatch', doc.registry);
  if (doc.issued_at > now + LIMITS.skewSeconds) throw new RegistryError('from_future');
  applyRollbackRule(doc.serial, sha256Of(bytes), lastSeen);
  return {
    revocations: doc,
    signer: sigDoc.keyid,
    ...trustOf(sigDoc, doc.registry, anchors, now),
    stale: now > doc.expires,
  };
}

/** Rollback and replay protection. Equal serial is only acceptable for identical bytes. */
function applyRollbackRule(serial, digest, lastSeen) {
  if (!lastSeen) return;
  if (serial < lastSeen.serial) throw new RegistryError('rollback', `${serial} < ${lastSeen.serial}`);
  if (serial === lastSeen.serial && digest !== lastSeen.sha256) throw new RegistryError('serial_replay');
}

/** Check bytes fetched for an asset (bundle, image, manual, report) against its index entry. */
export function checkAsset(ref, bytes) {
  if (bytes.length !== ref.size) throw new RegistryError('size_mismatch', `${bytes.length} != ${ref.size}`);
  if (sha256Of(bytes) !== ref.sha256) throw new RegistryError('hash_mismatch', ref.path);
  return true;
}

/** Check an app detail file against its index entry. Returns the parsed detail. */
export function checkDetail(appEntry, bytes) {
  if (bytes.length > LIMITS.detail) throw new RegistryError('too_large', 'app detail');
  checkAsset(appEntry.detail, bytes);
  const detail = parseAndCheck(bytes, 'app detail', 'app.schema.json', 'app', () => []);
  if (detail.app_id !== appEntry.app_id) throw new RegistryError('id_mismatch', detail.app_id);
  return detail;
}
