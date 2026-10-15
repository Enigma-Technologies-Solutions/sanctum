#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Builds the Enigma registry (docs/registry-format.md) from registry/ and the signed bundles.
//
//   node scripts/build-registry.mjs            build into web/registry/v1 and web/apps
//   node scripts/build-registry.mjs --check    fail if the committed files are out of date (CI)
//   node scripts/build-registry.mjs --renew    re-issue even if nothing changed (new serial)
//
// Options: --bundles DIR (default examples), --source DIR (registry), --out DIR
// (web/registry/v1), --site DIR (web/apps), --sitemap FILE (web/sitemap.xml),
// --anchor KEYID=NAME (repeatable; replaces the compiled-in anchors, for tests),
// --now UNIX.
//
// This script never signs. If index.json or revocations.json changed, its old .sig is
// removed and you sign the new file with scripts/sign-registry.sh. Then verify with
// scripts/verify-registry.mjs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, diffDir, readProductionAnchors, writeRegistry } from './lib/registry.mjs';
import { renderSite, renderSitemap } from './lib/site.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { anchors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--check') o.check = true;
    else if (a === '--renew') o.renew = true;
    else if (a === '--bundles') o.bundles = val();
    else if (a === '--source') o.source = val();
    else if (a === '--out') o.out = val();
    else if (a === '--site') o.site = val();
    else if (a === '--sitemap') o.sitemap = val();
    else if (a === '--now') o.now = Number(val());
    else if (a === '--anchor') {
      const [keyid, ...name] = val().split('=');
      o.anchors.push({ keyid, name: name.join('=') });
    } else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const outDir = resolve(o.out ?? join(repo, 'web/registry/v1'));
  const siteDir = resolve(o.site ?? join(repo, 'web/apps'));
  const sitemapPath = resolve(o.sitemap ?? join(repo, 'web/sitemap.xml'));
  const anchors = o.anchors.length ? o.anchors : readProductionAnchors(repo);
  const build = buildRegistry({
    sourceDir: resolve(o.source ?? join(repo, 'registry')),
    // Checking uses the bundles already committed in the registry, because the signed
    // originals under examples/ are not tracked.
    bundlesDir: resolve(o.bundles ?? (o.check ? join(outDir, 'bundles') : join(repo, 'examples'))),
    outDir,
    anchors,
    now: o.now ?? Math.floor(Date.now() / 1000),
    renew: o.renew,
  });
  const site = renderSite(build);
  const sitemap = renderSitemap(readFileSync(sitemapPath, 'utf8'), build);

  if (o.check) {
    const problems = [
      ...diffDir(outDir, build.files).map((p) => `registry: ${p}`),
      ...diffDir(siteDir, site).map((p) => `site: ${p}`),
      ...(readFileSync(sitemapPath, 'utf8') === sitemap ? [] : ['sitemap: changed']),
    ];
    if (problems.length) {
      console.error(`The committed registry is out of date:\n  ${problems.join('\n  ')}\nRun: node scripts/build-registry.mjs`);
      return 1;
    }
    console.log(`Registry up to date (index serial ${build.serial.index}, ${build.index.apps.length} apps, ${build.files.size} files).`);
    return 0;
  }

  writeRegistry(outDir, build.files);
  writeRegistry(siteDir, site);
  if (!existsSync(sitemapPath) || readFileSync(sitemapPath, 'utf8') !== sitemap) writeFileSync(sitemapPath, sitemap);

  const state = (k) => (build.changed[k] ? 'CHANGED, needs signing' : 'unchanged');
  console.log(`index.json        serial ${build.serial.index}: ${state('index')}`);
  console.log(`revocations.json  serial ${build.serial.revocations}: ${state('revocations')}`);
  console.log(`${build.index.apps.length} apps, ${build.files.size} registry files, ${site.size} pages.`);
  if (build.changed.index || build.changed.revocations) console.log('Next: scripts/sign-registry.sh');
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}
