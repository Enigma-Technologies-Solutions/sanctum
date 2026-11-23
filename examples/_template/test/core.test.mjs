// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Tests for the template's core. Run with: node --test examples/_template/test/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
// The repo root may set "type": "module", which would load a .js file as ESM and skip
// module.exports. Evaluate the file as a CommonJS style script in this realm instead.
const mod = { exports: {} };
new Function("module", readFileSync(join(here, "..", "src", "tool-core.js"), "utf8"))(mod);
const { countText, looksBinary, summary } = mod.exports;

test("counts an empty text as nothing", () => {
  assert.deepEqual(countText(""), { words: 0, lines: 0, chars: 0, bytes: 0 });
});

test("counts words, lines, characters and UTF-8 bytes", () => {
  assert.deepEqual(countText("one two\nthree\n"), { words: 3, lines: 2, chars: 14, bytes: 14 });
  assert.deepEqual(countText("a\r\nb\rc"), { words: 3, lines: 3, chars: 6, bytes: 6 });
  // An accented letter is one character and two bytes; an emoji outside the BMP is one and four.
  assert.deepEqual(countText("café \u{1F600}"), { words: 2, lines: 1, chars: 6, bytes: 10 });
});

test("the split rule decides what a word is", () => {
  assert.equal(countText("well-known, isn't it?", "space").words, 3);
  assert.equal(countText("well-known, isn't it?", "punct").words, 4);
  assert.throws(() => countText("x", "nope"), /unknown split/);
});

test("finds binary data by its NUL bytes", () => {
  assert.equal(looksBinary(new Uint8Array([104, 105, 10])), false);
  assert.equal(looksBinary(new Uint8Array([104, 0, 105])), true);
});

test("sums a count up in one line", () => {
  assert.equal(summary({ words: 1, lines: 1, chars: 5, bytes: 5 }), "1 word, 1 line, 5 characters, 5 bytes in UTF-8");
});

test("the build inlines the kit and the core, and adds no capability string", () => {
  const dir = mkdtempSync(join(tmpdir(), "tool-template-"));
  try {
    const out = join(dir, "index.html");
    execFileSync(process.execPath, [join(here, "..", "build.mjs"), "--out", out], { stdio: "pipe" });
    const html = readFileSync(out, "utf8");
    for (const mark of ["/*__KIT_CSS__*/", "/*__KIT_JS__*/", "<!--__KIT_ICONS__-->", "/*__TOOL_CORE__*/"]) {
      assert.ok(!html.includes(mark), mark + " was not replaced");
    }
    assert.match(html, /root\.ToolCore = api/);
    assert.match(html, /globalThis\.EnigmaKit = /);
    assert.match(html, /@font-face\{font-family:'Inter'/);
    assert.match(html, /<html lang="en" data-theme="light">/);
    for (const s of ["localStorage", "sessionStorage", "indexedDB", "document.cookie", "fetch(", "https://"]) {
      assert.ok(!html.includes(s), "built file contains " + s);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
