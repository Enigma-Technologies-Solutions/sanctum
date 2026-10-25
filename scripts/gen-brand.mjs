#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Raster brand assets, drawn by headless Chrome from SVG and HTML so the type is the real
// type. Nothing here is hand-edited: change this file or assets/logo/, then run it.
//
//   node scripts/gen-brand.mjs [icons] [site] [apps] [blog]      (default: all)
//   node scripts/gen-brand.mjs blog --preview DIR                 drafts too, into DIR
//
// icons  src-tauri/icons/icon.png, web favicons (ico, 32/192/512 png, apple touch icon)
// site   web/assets/og.png, the social card for the home page
// apps   web/apps/<app_id>/og.png, one social card per signed tool (from the registry index)
// blog   web/blog/<slug>/cover.png (1200x630) and thumb.png (600x400), from blog-src/*.md.
//        Drafts (`draft: "true"`) are skipped: web/ is what deploys, and a draft's cover
//        would publish its title. With --preview DIR every post, drafts included, is drawn
//        into DIR/<slug>/ instead, next to what `build-blog.mjs --preview DIR` writes.
//
// Needs Google Chrome (CHROME=/path to override) and ImageMagick for the .ico.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { frontmatter } from './lib/blog.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FONTS = pathToFileURL(join(repo, 'web/assets/fonts')).href;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Render `html` to a PNG of exactly w x h. `transparent` keeps the page background clear. */
export function shot(html, out, w, h, { transparent = false, scale = 1 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sanctum-brand-'));
  try {
    const page = join(dir, 'page.html');
    writeFileSync(page, html);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync(
      CHROME,
      [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
        `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`,
        `--default-background-color=${transparent ? '00000000' : 'FF0A0A0A'}`,
        `--screenshot=${out}`, pathToFileURL(page).href,
      ],
      { stdio: 'ignore' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(out)) throw new Error(`Chrome produced nothing for ${out}`);
}

const fontFaces = `
@font-face{font-family:Inter;font-weight:100 900;src:url(${FONTS}/Inter-var.woff2) format('woff2')}
@font-face{font-family:Poppins;font-weight:600;src:url(${FONTS}/Poppins-600.woff2) format('woff2')}
@font-face{font-family:Poppins;font-weight:700;src:url(${FONTS}/Poppins-700.woff2) format('woff2')}
@font-face{font-family:Poppins;font-weight:800;src:url(${FONTS}/Poppins-800.woff2) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:400;src:url(${FONTS}/SpaceMono-400.woff2) format('woff2')}
@font-face{font-family:'Space Mono';font-weight:700;src:url(${FONTS}/SpaceMono-700.woff2) format('woff2')}`;

const svg = (f) => readFileSync(join(repo, f), 'utf8');
/** The monogram tile as inline SVG at a given size (the same artwork as the app icon). */
const mark = (size) => svg('web/assets/favicon.svg').replace('<svg ', `<svg width="${size}" height="${size}" style="display:block" `).replace(/\swidth="64"\s+height="64"/, '');

/**
 * The social card. Black, the yellow bar, one big line, one quiet line, a caption and the
 * monogram. `size` "og" is 1200x630, "thumb" is 600x400 (blog list).
 */
export function cardHtml({ kicker, title, sub, foot, size = 'og' }) {
  const og = size === 'og';
  const W = og ? 1200 : 600, H = og ? 630 : 400;
  const titleSize = og ? (title.length > 28 ? 76 : title.length > 16 ? 96 : 120) : title.length > 28 ? 40 : 52;
  return `<!doctype html><meta charset="utf-8"><style>${fontFaces}
*{margin:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;background:#0A0A0A;color:#fff;overflow:hidden}
.c{position:relative;width:${W}px;height:${H}px;padding:${og ? '72px 80px' : '36px 40px'};font-family:Inter,sans-serif}
.bar{width:${og ? 64 : 36}px;height:${og ? 14 : 8}px;background:#FBFF00;margin-bottom:${og ? 34 : 20}px}
.k{font:700 ${og ? 22 : 13}px 'Space Mono',monospace;letter-spacing:.16em;text-transform:uppercase;color:#FBFF00;margin-bottom:${og ? 22 : 12}px}
h1{font:800 ${titleSize}px/1.04 Poppins,sans-serif;letter-spacing:-.02em;max-width:${og ? 700 : 400}px}
.s{margin-top:${og ? 28 : 14}px;font:400 ${og ? 28 : 15}px/1.4 'Space Mono',monospace;color:#9AA0A8;max-width:${og ? 680 : 400}px}
.f{position:absolute;left:${og ? 80 : 40}px;bottom:${og ? 64 : 30}px;font:400 ${og ? 19 : 11}px 'Space Mono',monospace;letter-spacing:.12em;text-transform:uppercase;color:#6B717A}
.m{position:absolute;right:${og ? 80 : 40}px;top:50%;transform:translateY(-50%)}
</style><div class="c"><div class="bar"></div>${kicker ? `<div class="k">${esc(kicker)}</div>` : ''}<h1>${esc(title)}</h1>${sub ? `<div class="s">${esc(sub)}</div>` : ''}${foot ? `<div class="f">${esc(foot)}</div>` : ''}<div class="m">${mark(og ? 300 : 150)}</div></div>`;
}

// ── Targets ─────────────────────────────────────────────────────────────────

function icons() {
  // Linux / generic app icon: the macOS-grid app icon, transparent outside the tile.
  const big = (px) => `<!doctype html><style>*{margin:0}html,body{width:${px}px;height:${px}px;background:transparent}</style>${svg('assets/logo/app-icon.svg').replace(/width="1024" height="1024"/, `width="${px}" height="${px}"`)}`;
  shot(big(512), join(repo, 'src-tauri/icons/icon.png'), 512, 512, { transparent: true });

  // Favicons: the full-bleed tile (favicon.svg), opaque so every browser shows the same thing.
  const tile = (px) => `<!doctype html><style>*{margin:0}html,body{width:${px}px;height:${px}px;background:#0A0A0A}</style>${mark(px)}`;
  const assets = join(repo, 'web/assets');
  for (const [name, px] of [['favicon-32.png', 32], ['favicon-48.png', 48], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    shot(tile(px), join(assets, name), px, px);
  }
  execFileSync('magick', [join(assets, 'favicon-32.png'), join(assets, 'favicon-48.png'), join(repo, 'web/favicon.ico')]);
}

function site() {
  shot(
    cardHtml({ title: 'Sanctum', sub: 'A desktop sandbox for the HTML tools AI models write for you.', foot: 'Open source · AGPL-3.0 · macOS · Windows · Linux' }),
    join(repo, 'web/assets/og.png'), 1200, 630,
  );
}

function apps() {
  const index = JSON.parse(readFileSync(join(repo, 'web/registry/v1/index.json'), 'utf8'));
  for (const a of index.apps) {
    shot(
      cardHtml({ kicker: 'Signed tool for Sanctum', title: a.name, sub: a.summary, foot: `${a.publisher.name} · v${a.latest}` }),
      join(repo, 'web/apps', a.app_id, 'og.png'), 1200, 630,
    );
  }
}

function blog(previewDir = null) {
  const src = join(repo, 'blog-src');
  if (!existsSync(src)) return;
  for (const f of readdirSync(src).filter((n) => n.endsWith('.md'))) {
    const { data } = frontmatter(readFileSync(join(src, f), 'utf8'));
    if (data.draft === 'true' && !previewDir) {
      console.log(`  skip draft ${data.slug} (preview it with --preview DIR)`);
      continue;
    }
    const out = join(previewDir ?? join(repo, 'web/blog'), data.slug);
    const card = { kicker: data.kicker ?? 'Sanctum blog', title: data.cover_title ?? data.title, sub: data.cover_sub ?? '', foot: data.date };
    shot(cardHtml({ ...card, size: 'og' }), join(out, 'cover.png'), 1200, 630);
    // Laid out at 600x400 and drawn at 2x, so it is sharp on a high-density screen.
    shot(cardHtml({ ...card, sub: '', size: 'thumb' }), join(out, 'thumb.png'), 600, 400, { scale: 2 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--preview');
  if (pi >= 0 && !args[pi + 1]) throw new Error('--preview needs a directory');
  const previewDir = pi >= 0 ? resolve(args[pi + 1]) : null;
  const want = args.filter((a, i) => pi < 0 || (i !== pi && i !== pi + 1));
  if (previewDir && want.some((n) => n !== 'blog')) throw new Error('--preview only applies to the blog target');
  const all = { icons, site, apps, blog };
  for (const name of want.length ? want : previewDir ? ['blog'] : Object.keys(all)) {
    if (!all[name]) throw new Error(`unknown target: ${name}`);
    console.log(`${name} ...`);
    name === 'blog' ? blog(previewDir) : all[name]();
  }
  console.log('done');
}
