// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Builds the registry files described in docs/registry-format.md from the sources in
// registry/ and the signed bundles. Pure functions plus a little file reading; nothing here
// signs anything or touches a key. Signing is `sanctum-bundle registry-sign`.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { FORMATS, RegistryError, decodeB64u, sha256Of, trustOf, validate, verifyDomain } from '../../spec/registry/reference.mjs';
import { parseChangelog } from './changelog.mjs';
import { imageSize } from './images.mjs';
import { renderMarkdown } from './markdown.mjs';

const STATEMENT_DOMAIN = 'sanctum-statement-v1\n';
const DAY = 86_400;

export const json = (o) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`);

// ── Trust anchors ─────────────────────────────────────────────────────────────

/** The anchors compiled into the app, read from trust.rs so there is one source of truth. */
export function readProductionAnchors(repoRoot) {
  const src = readFileSync(join(repoRoot, 'src-tauri/src/trust.rs'), 'utf8');
  const block = /COMPILED_ANCHORS[^=]*=\s*&\[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
  const anchors = [...block.matchAll(/"(ed25519:[A-Za-z0-9_-]{43})"\s*,\s*"([^"]+)"/g)].map((m) => ({ keyid: m[1], name: m[2] }));
  if (!anchors.length) throw new Error('could not read the compiled-in anchors from src-tauri/src/trust.rs');
  return anchors;
}

// ── Bundles ───────────────────────────────────────────────────────────────────

/**
 * Verify a `.sanctum` file the way the app does: signature, checksum, and that the signer is
 * anchored for this app id. Returns what the registry needs. Throws unless anchored.
 */
export function verifyBundle(bytes, anchors, now, label = 'bundle') {
  let b;
  try {
    b = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label}: not JSON`);
  }
  if (b.format !== 'sanctum-bundle/1') throw new Error(`${label}: unsupported format ${b.format}`);
  const env = b.signature;
  const payload = decodeB64u(env.payload);
  if (!verifyDomain(STATEMENT_DOMAIN, payload, env.sig, env.keyid)) throw new Error(`${label}: signature does not verify`);
  const statement = JSON.parse(payload.toString('utf8'));
  const actual = sha256Of(Buffer.from(b.html, 'utf8'));
  if (actual !== statement.checksum) throw new Error(`${label}: file does not match the signed checksum`);
  const trust = trustOf({ keyid: env.keyid, chain: env.chain ?? [] }, statement.app_id, anchors, now);
  if (trust.trust !== 'anchored') {
    throw new Error(`${label}: not anchored to a trusted key${trust.reason ? ` (${trust.reason})` : ''}`);
  }
  return { statement, html: b.html, signer: env.keyid, publisher: trust.publisher };
}

function parseVersion(v) {
  return v.split('.').map(Number);
}
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

/** `.sanctum` files under `dir`, grouped by app id: Map<appId, [{ version, path }]>. */
export function findBundles(dir) {
  const byApp = new Map();
  for (const p of listFiles(dir)) {
    const m = /^(.+)-(\d+(?:\.\d+){0,3})\.sanctum$/.exec(p.split('/').pop());
    if (!m) continue;
    if (!byApp.has(m[1])) byApp.set(m[1], []);
    byApp.get(m[1]).push({ version: m[2], path: p });
  }
  return byApp;
}

// ── Icon ──────────────────────────────────────────────────────────────────────

const UNSAFE_SVG = /<script|\son\w+\s*=|javascript:|<foreignObject|<image|<use[\s>]|xlink:href|\shref\s*=|<!ENTITY|<style/i;

/** The inline data: SVG a tool declares as its icon, as file text, or null. */
export function extractIconSvg(html) {
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']icon["']/i.test(tag[0])) continue;
    const href = /\bhref\s*=\s*"(data:image\/svg\+xml,[^"]*)"/i.exec(tag[0])?.[1];
    if (!href) continue;
    let svg;
    try {
      svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
    } catch {
      throw new Error('icon: bad percent-encoding');
    }
    if (!svg.startsWith('<svg')) throw new Error('icon: not an SVG');
    if (UNSAFE_SVG.test(svg)) throw new Error('icon: SVG contains script, links, styles or embedded content');
    if (Buffer.byteLength(svg) > 262144) throw new Error('icon: over 256 KiB');
    return `${svg}\n`;
  }
  return null;
}

// ── Build ─────────────────────────────────────────────────────────────────────

function need(cond, msg) {
  if (!cond) throw new Error(msg);
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${p}: ${e.message}`);
  }
}

function readPrev(outDir, name) {
  const p = join(outDir, name);
  if (!existsSync(p)) return null;
  const bytes = readFileSync(p);
  try {
    const d = JSON.parse(bytes.toString('utf8'));
    return { bytes, serial: d.serial, issued_at: d.issued_at, expires: d.expires };
  } catch {
    return null;
  }
}

/**
 * Pick serial and times for a signed document. If rebuilding with the previous serial and
 * times gives the same bytes, nothing changed and the old signature stays valid. Otherwise
 * the serial goes up by one and the times restart.
 */
function withFreshness(make, prev, { now, days, renew }) {
  if (prev && !renew) {
    const same = make({ serial: prev.serial, issued_at: prev.issued_at, expires: prev.expires });
    if (same.equals(prev.bytes)) return { bytes: same, changed: false, serial: prev.serial };
  }
  const serial = (prev?.serial ?? 0) + 1;
  const bytes = make({ serial, issued_at: now, expires: now + days * DAY });
  return { bytes, changed: true, serial };
}

/**
 * @param {object} o
 * @param {string} o.sourceDir  registry/ (registry.json, revocations.json, apps/<app_id>/...)
 * @param {string} o.bundlesDir directory scanned for signed .sanctum files
 * @param {string} o.outDir     the registry directory (web/registry/v1), read for the previous serial
 * @param {{keyid:string,name:string}[]} o.anchors
 * @param {number} o.now        unix seconds
 * @param {boolean} [o.renew]   re-issue even if nothing changed (new serial, fresh expiry)
 */
export function buildRegistry({ sourceDir, bundlesDir, outDir, anchors, now, renew = false }) {
  const cfg = readJson(join(sourceDir, 'registry.json'));
  for (const k of ['id', 'name', 'kind', 'index_days', 'revocations_days']) need(k in cfg, `registry.json: missing ${k}`);

  const found = findBundles(bundlesDir);
  const files = new Map(); // relative path in the registry -> Buffer
  const appEntries = [];
  const sitePages = [];

  const appDirs = readdirSync(join(sourceDir, 'apps'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  need(appDirs.length > 0, 'registry/apps has no apps');

  for (const appId of appDirs) {
    const dir = join(sourceDir, 'apps', appId);
    const meta = readJson(join(dir, 'app.json'));
    need(meta.app_id === appId, `${appId}/app.json: app_id must equal the folder name`);
    for (const k of ['summary', 'description']) need(typeof meta[k] === 'string' && meta[k], `${appId}/app.json: missing ${k}`);

    // Which versions to publish: the ones named in app.json, else the newest bundle.
    const available = found.get(appId) ?? [];
    need(available.length > 0, `${appId}: no signed .sanctum file found under ${relative(process.cwd(), bundlesDir) || bundlesDir}`);
    const wanted = meta.versions ?? [available.map((b) => b.version).sort(compareVersions).pop()];
    const published = [];
    for (const version of [...wanted].sort((a, b) => compareVersions(b, a))) {
      const src = available.find((b) => b.version === version);
      need(src, `${appId}: version ${version} is listed in app.json but no ${appId}-${version}.sanctum exists`);
      const bytes = readFileSync(src.path);
      const v = verifyBundle(bytes, anchors, now, `${appId}-${version}.sanctum`);
      need(v.statement.app_id === appId, `${appId}-${version}.sanctum: signed for ${v.statement.app_id}`);
      need(v.statement.version === version, `${appId}-${version}.sanctum: signed as version ${v.statement.version}`);
      published.push({ version, bytes, ...v });
    }
    const newest = published[0];

    // Changelog must cover every published version.
    const changelog = parseChangelog(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'));
    for (const p of published) need(changelog.some((c) => c.version === p.version), `${appId}/CHANGELOG.md: no entry for published version ${p.version}`);

    // Assets.
    const base = `apps/${appId}`;
    const detail = {
      format: FORMATS.app,
      app_id: appId,
      description: meta.description,
    };
    for (const k of ['homepage', 'source', 'license']) if (meta[k]) detail[k] = meta[k];
    detail.changelog = changelog;

    const asset = (path, bytes, extra = {}) => {
      files.set(path, bytes);
      return { path, sha256: sha256Of(bytes), size: bytes.length, ...extra };
    };

    let manualHtml = null;
    const manualPath = join(dir, 'manual.md');
    if (existsSync(manualPath)) {
      const bytes = readFileSync(manualPath);
      manualHtml = renderMarkdown(bytes.toString('utf8')); // throws on anything outside the subset
      detail.manual = asset(`${base}/manual.md`, bytes);
    }

    const shots = [];
    for (const s of meta.screenshots ?? []) {
      need(s.file && s.alt, `${appId}/app.json: each screenshot needs file and alt`);
      const bytes = readFileSync(join(dir, 'screenshots', s.file));
      const { width, height } = imageSize(bytes);
      shots.push(asset(`${base}/${s.file}`, bytes, { width, height, alt: s.alt }));
    }
    if (shots.length) detail.screenshots = shots;

    const iconSvg = extractIconSvg(newest.html);
    const icon = iconSvg ? asset(`${base}/icon.svg`, Buffer.from(iconSvg)) : null;

    const detailBytes = json(detail);
    const detailRef = { path: `${base}.json`, sha256: sha256Of(detailBytes), size: detailBytes.length };
    files.set(detailRef.path, detailBytes);

    const versions = published.map((p) => {
      const path = `bundles/${appId}-${p.version}.sanctum`;
      files.set(path, p.bytes);
      return {
        version: p.version,
        published_at: p.statement.issued_at,
        bundle: { path, sha256: sha256Of(p.bytes), size: p.bytes.length },
        checksum: p.statement.checksum,
        declared: p.statement.declared,
      };
    });

    const entry = {
      app_id: appId,
      name: newest.statement.name,
      summary: meta.summary,
      publisher: { keyid: newest.signer, name: newest.publisher },
      access: 'free',
      latest: newest.version,
    };
    if (icon) entry.icon = icon;
    entry.detail = detailRef;
    entry.versions = versions;
    appEntries.push(entry);
    sitePages.push({ entry, detail, manualHtml });
  }

  // index.json
  const prevIndex = readPrev(outDir, 'index.json');
  const index = withFreshness(
    (m) => {
      const doc = { format: FORMATS.index, id: cfg.id, name: cfg.name, kind: cfg.kind, ...m };
      if (cfg.mirrors?.length) doc.mirrors = cfg.mirrors;
      doc.revocations = 'revocations.json';
      doc.apps = appEntries;
      return json(doc);
    },
    prevIndex,
    { now, days: cfg.index_days, renew },
  );
  files.set('index.json', index.bytes);

  // revocations.json
  const revSource = existsSync(join(sourceDir, 'revocations.json')) ? readJson(join(sourceDir, 'revocations.json')) : { entries: [] };
  const entries = [...revSource.entries].sort((a, b) => a.checksum.localeCompare(b.checksum));
  const prevRev = readPrev(outDir, 'revocations.json');
  const revocations = withFreshness(
    (m) => json({ format: FORMATS.revocations, registry: cfg.id, ...m, entries }),
    prevRev,
    { now, days: cfg.revocations_days, renew },
  );
  files.set('revocations.json', revocations.bytes);

  // Check our own output against the spec before anyone signs it.
  const indexDoc = JSON.parse(index.bytes.toString('utf8'));
  const problems = [
    ...validate('index.schema.json', indexDoc),
    ...validate('revocations.schema.json', JSON.parse(revocations.bytes.toString('utf8'))),
  ];
  for (const p of sitePages) problems.push(...validate('app.schema.json', p.detail));
  if (problems.length) throw new RegistryError('schema_invalid', problems[0]);

  return {
    files,
    sitePages,
    config: cfg,
    index: indexDoc,
    changed: { index: index.changed, revocations: revocations.changed },
    serial: { index: index.serial, revocations: revocations.serial },
  };
}

// ── Writing ───────────────────────────────────────────────────────────────────

/**
 * Make `dir` contain exactly `files`, plus any `.sig` whose file is unchanged, plus anything
 * `preserve(rel)` says belongs to another generator (the social images from gen-brand.mjs). A signature
 * beside a file that changed is removed: it no longer matches, and leaving it would make the
 * registry look signed when it is not.
 */
export function writeRegistry(dir, files, { preserve = () => false } = {}) {
  const keep = new Set([...files.keys()]);
  for (const p of listFiles(dir)) {
    const rel = relative(dir, p);
    if (rel.endsWith('.sig')) {
      const target = rel.slice(0, -4);
      const same = files.has(target) && existsSync(join(dir, target)) && readFileSync(join(dir, target)).equals(files.get(target));
      if (!same) rmSync(p);
      continue;
    }
    if (!keep.has(rel) && !preserve(rel)) rmSync(p);
  }
  for (const [rel, bytes] of files) {
    const dest = join(dir, rel);
    if (existsSync(dest) && readFileSync(dest).equals(bytes)) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
}

/** Differences between a built file set and a directory (signatures ignored). */
export function diffDir(dir, files, { ignoreSig = true, preserve = () => false } = {}) {
  const problems = [];
  for (const [rel, bytes] of files) {
    const p = join(dir, rel);
    if (!existsSync(p)) problems.push(`missing: ${rel}`);
    else if (!readFileSync(p).equals(bytes)) problems.push(`changed: ${rel}`);
  }
  for (const p of listFiles(dir)) {
    const rel = relative(dir, p);
    if (ignoreSig && rel.endsWith('.sig')) continue;
    if (!files.has(rel) && !preserve(rel)) problems.push(`stale: ${rel}`);
  }
  return problems;
}

export const sha256Hex = (b) => createHash('sha256').update(b).digest('hex');
