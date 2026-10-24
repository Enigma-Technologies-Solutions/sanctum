import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "./load.mjs";

const PINNED = "0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f";
const text = readFileSync(join(ROOT, "vendor", "pdf-lib.min.js"), "utf8");

test("the vendored pdf-lib is the pinned file", () => {
  assert.equal(createHash("sha256").update(readFileSync(join(ROOT, "vendor", "pdf-lib.min.js"))).digest("hex"), PINNED);
  assert.match(readFileSync(join(ROOT, "vendor", "README.md"), "utf8"), new RegExp(PINNED));
});

test("it can be inlined in a script tag and holds no dynamic code", () => {
  assert.ok(!/<\/script/i.test(text));
  assert.ok(!/\beval\s*\(/.test(text));
  assert.ok(!/new Function/.test(text));
  assert.ok(!/importScripts|new Worker|XMLHttpRequest|WebSocket|sendBeacon/.test(text));
});

test("the core holds no network or dynamic code either", () => {
  const core = readFileSync(join(ROOT, "src", "watermark-core.js"), "utf8");
  assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\beval\s*\(|new Function|document\.|window\./.test(core));
  assert.ok(!/<\/script/i.test(core));
});
