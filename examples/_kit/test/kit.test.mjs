// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Tests for the shared kit. Run with: node --test examples/_kit/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { applyKit, findForbidden, kitParts, PLACEHOLDERS } from "../kit.mjs";

const page = (extra = "") =>
  `<html><head><style>${PLACEHOLDERS.css}</style></head><body>${PLACEHOLDERS.icons}${extra}<script>${PLACEHOLDERS.js}</script></body></html>`;

test("the kit contains nothing Sanctum would read as a capability", () => {
  const { css, js, icons } = kitParts();
  assert.deepEqual(findForbidden(css + js + icons), []);
});

test("the theme switch keeps nothing: no browser storage, no cookies", () => {
  const { js } = kitParts();
  for (const s of ["Storage", "indexedDB", "cookie", "caches"]) assert.ok(!js.includes(s), "kit.js mentions " + s);
});

test("light is the default and dark is opt-in", () => {
  const { css } = kitParts();
  assert.match(css, /:root\{\s*color-scheme:light;/);
  assert.match(css, /:root\[data-theme="dark"\]\{\s*color-scheme:dark;/);
  assert.ok(!css.includes("prefers-color-scheme"), "the kit must not follow the system theme");
});

test("the fonts are embedded, not fetched", () => {
  const { css } = kitParts();
  const faces = css.match(/@font-face\{[^}]*\}/g) ?? [];
  assert.equal(faces.length, 5);
  for (const f of faces) assert.match(f, /src:url\(data:font\/woff2;base64,/);
});

test("applyKit replaces each placeholder once", () => {
  const html = applyKit(page());
  for (const mark of Object.values(PLACEHOLDERS)) assert.ok(!html.includes(mark));
  assert.match(html, /<symbol id="i-moon"/);
});

test("applyKit refuses a missing or repeated placeholder", () => {
  assert.throws(() => applyKit(page().replace(PLACEHOLDERS.js, "")), /exactly once, found 0/);
  assert.throws(() => applyKit(page(PLACEHOLDERS.icons)), /exactly once, found 2/);
});

test("applyKit refuses an icon id the kit already defines", () => {
  const dup = '<svg><symbol id="i-copy" viewBox="0 0 24 24"></symbol></svg>';
  assert.throws(() => applyKit(page(dup)), /icon id defined twice: i-copy/);
});

test("findForbidden ignores the SVG namespace, as the scanner does", () => {
  assert.deepEqual(findForbidden('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), []);
  assert.deepEqual(findForbidden("x = localStorage"), ["localStorage"]);
});
