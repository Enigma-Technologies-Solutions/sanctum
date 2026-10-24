#!/usr/bin/env node
// Builds index.html by inlining vendor/pdf-lib.min.js and src/watermark-core.js into
// src/app.template.html.
//   node build.mjs                 -> index.html
//   node build.mjs --out <path>    -> write somewhere else (for tests)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PDFLIB_SHA256 = "0f9a5cad07941f0826586c94e089d89b918c46e5c17cf2d5a3c6f666e3bc694f";
const SLOTS = [
  ["/*__PDFLIB__*/", join(here, "vendor", "pdf-lib.min.js")],
  ["/*__WATERMARK_CORE__*/", join(here, "src", "watermark-core.js")],
];

function fail(msg) {
  console.error("build failed: " + msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a.startsWith("--") && a !== "--out");
if (unknown.length) fail("unknown option " + unknown[0]);
const oi = args.indexOf("--out");
if (oi >= 0 && (!args[oi + 1] || args[oi + 1].startsWith("--"))) fail("--out needs a path");
const out = oi >= 0 ? resolve(args[oi + 1]) : join(here, "index.html");

const templatePath = join(here, "src", "app.template.html");
if (!existsSync(templatePath)) fail("missing " + templatePath);
let html = readFileSync(templatePath, "utf8");

for (const [placeholder, path] of SLOTS) {
  if (!existsSync(path)) fail("missing " + path);
  const bytes = readFileSync(path);
  if (path.endsWith("pdf-lib.min.js") && createHash("sha256").update(bytes).digest("hex") !== PDFLIB_SHA256) {
    fail("vendor/pdf-lib.min.js is not the pinned file (see vendor/README.md)");
  }
  const code = bytes.toString("utf8");
  const count = html.split(placeholder).length - 1;
  if (count !== 1) fail("template must contain " + placeholder + " exactly once, found " + count);
  if (/<\/script/i.test(code)) fail(path + " contains '</script' and would end the script tag early");
  // A function replacer keeps '$' sequences in the code from being treated as patterns.
  html = html.replace(placeholder, () => code.replace(/\s+$/, ""));
}

writeFileSync(out, html);
console.log("wrote " + out + " (" + html.length + " bytes)");
