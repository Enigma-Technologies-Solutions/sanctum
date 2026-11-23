#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Registry screenshots of an example tool, drawn by headless Chrome from the built
// examples/<tool>/index.html, the way scripts/gen-brand.mjs draws the brand images.
//
//   node scripts/tool-screens.mjs hash-check                 -> registry/apps/<app id>/screenshots/
//   node scripts/tool-screens.mjs hash-check --out DIR       -> somewhere else, to look first
//   node scripts/tool-screens.mjs hash-check --theme dark    -> the dark theme
//
// Each scene is a script run inside the page before Chrome takes the picture: it fills the
// form, presses buttons and scrolls. Chrome runs on virtual time (--virtual-time-budget), so
// the scene can wait for the tool to finish. The page is a temporary copy; the tool's own file
// is not changed. A tool's scenes live in examples/<tool>/screens.mjs, whose default export is
// { appId, scenes } (scene bodies may use the page helpers below); SCENES below holds the first two.
//
// Needs Google Chrome (CHROME=/path to override).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// The size of the screenshots already in the registry.
const W = 1600;
const H = 1131;

// Helpers every scene can call inside the page.
const PAGE_HELPERS = `
var $ = function (s) { return document.querySelector(s); };
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, ms) { var end = Date.now() + (ms || 20000); while (!fn()) { if (Date.now() > end) throw new Error("scene timed out"); await sleep(50); } }
function pickFile(sel, name, bytes) {
  var dt = new DataTransfer();
  dt.items.add(new File([bytes], name, { type: "application/octet-stream" }));
  var input = $(sel); input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function type(sel, text) { var el = $(sel); el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); }
function press(sel) { $(sel).click(); }
// Bring the element up to just under the header. Headless Chrome draws a scrolled page badly,
// so the page does not scroll: everything after the header moves up instead.
function scrollToEl(sel, gap) {
  var bar = $("header.bar"), h = bar ? bar.offsetHeight : 0;
  var top = $(sel).getBoundingClientRect().top + window.scrollY;
  var dy = Math.max(0, top - h - (gap == null ? 24 : gap));
  document.documentElement.style.overflow = "hidden";
  Array.prototype.forEach.call(document.body.children, function (el) {
    if (el !== bar && el.tagName !== "SCRIPT") { el.style.transform = "translateY(-" + dy + "px)"; }
  });
  if (bar) { bar.style.position = "relative"; bar.style.zIndex = "100"; }
}
`;

// ── Hash Check ───────────────────────────────────────────────────────────────
// A made-up 3 MB release file, the same bytes every time, and a SHA256SUMS list for it.
const HC_SIZE = 3 * 1024 * 1024;
function hcBytes() {
  const b = new Uint8Array(HC_SIZE);
  let x = 0x9e3779b9;
  for (let i = 0; i < b.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; }
  return b;
}
const hcHash = createHash('sha256').update(hcBytes()).digest('hex');
const hcSums = (h) => [
  '# SHA256SUMS for release 1.0.0',
  `039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81  sanctum-1.0.0-linux-amd64.deb`,
  `${h}  sanctum-1.0.0-universal.dmg`,
  `2b4c342f5433ebe591a1da77e013d1b72475562d48578dca8b84bac6651c3cb9  sanctum-1.0.0-windows-x64.msi`,
].join('\n');
// The same hash with two characters changed, for the mismatch.
const hcWrong = hcHash.slice(0, 20) + (hcHash[20] === 'a' ? 'b' : 'a') + hcHash.slice(21, 40) + (hcHash[40] === 'c' ? 'd' : 'c') + hcHash.slice(41);
const HC_FILE = `
var x = 0x9e3779b9 | 0, b = new Uint8Array(${HC_SIZE});
for (var i = 0; i < b.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; }
pickFile("#picker", "sanctum-1.0.0-universal.dmg", b);
`;

const SCENES = {
  // The template has no registry entry, so it needs --out.
  '_template': {
    appId: null,
    scenes: {
      'overview.png': ``,
      'counted.png': `
        type("#text", "Sanctum runs single-file HTML tools in separate windows.\\nEach one gets only the access you approve.\\n");
        press('[data-split="punct"]');
        scrollToEl("#h-rule");`,
    },
  },
  'hash-check': {
    appId: 'sh.enigma.hash-check',
    scenes: {
      'overview.png': ``,
      'ready.png': `${HC_FILE}
        type("#expected", ${JSON.stringify(hcSums(hcHash))});
        scrollToEl("#h-file", 40);`,
      'match.png': `${HC_FILE}
        type("#expected", ${JSON.stringify(hcSums(hcHash))});
        press("#run");
        await until(function () { return !$("#result").hidden; });
        scrollToEl("#h-sum");`,
      'mismatch.png': `${HC_FILE}
        type("#expected", ${JSON.stringify(hcSums(hcWrong))});
        press("#run");
        await until(function () { return !$("#result").hidden; });
        scrollToEl("#h-sum");`,
    },
  },
};

function shoot(html, out) {
  const dir = mkdtempSync(join(tmpdir(), 'sanctum-screens-'));
  try {
    const page = join(dir, 'page.html');
    writeFileSync(page, html);
    mkdirSync(dirname(out), { recursive: true });
    execFileSync(
      CHROME,
      [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
        '--force-device-scale-factor=1', `--window-size=${W},${H}`,
        '--virtual-time-budget=30000', '--run-all-compositor-stages-before-draw',
        `--screenshot=${out}`, pathToFileURL(page).href,
      ],
      { stdio: 'ignore' },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!existsSync(out)) throw new Error(`Chrome produced nothing for ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tool = args[0];
  const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
  let entry = tool && SCENES[tool];
  const own = tool && join(repo, 'examples', tool, 'screens.mjs');
  if (!entry && own && existsSync(own)) entry = (await import(pathToFileURL(own).href)).default;
  if (!entry) throw new Error(`usage: tool-screens.mjs <${Object.keys(SCENES).join('|')}|a tool with screens.mjs> [--out DIR] [--theme light|dark]`);
  const { appId, scenes } = entry;
  const theme = opt('--theme') ?? 'light';
  if (!['light', 'dark'].includes(theme)) throw new Error('--theme is light or dark');
  if (!appId && !opt('--out')) throw new Error(`${tool} has no registry entry; pass --out DIR`);
  const outDir = resolve(opt('--out') ?? join(repo, 'registry/apps', appId, 'screenshots'));
  const base = readFileSync(join(repo, 'examples', tool, 'index.html'), 'utf8');
  if (!base.includes('</body>')) throw new Error('index.html has no </body>');
  for (const [file, steps] of Object.entries(scenes)) {
    const scene = `<script>(async function () {
${PAGE_HELPERS}
if (${JSON.stringify(theme)} === "dark") globalThis.EnigmaKit.setTheme("dark");
${steps}
})();</script>`;
    shoot(base.replace('</body>', () => scene + '\n</body>'), join(outDir, file));
    console.log(`wrote ${join(outDir, file)}`);
  }
}
