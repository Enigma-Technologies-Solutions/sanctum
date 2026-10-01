#!/usr/bin/env node
// Builds index.html by inlining src/shamir-core.js into src/app.template.html.
//   node build.mjs                      -> index.html
//   node build.mjs --mock <core.js>     -> inline a different core file (testing only)
//   node build.mjs --out <path>         -> write somewhere else (use with --mock)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLACEHOLDER = "/*__SHAMIR_CORE__*/";

function fail(msg) {
  console.error("build failed: " + msg);
  process.exit(1);
}

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) fail(name + " needs a path");
  return resolve(v);
}
const unknown = args.filter((a) => a.startsWith("--") && !["--mock", "--out"].includes(a));
if (unknown.length) fail("unknown option " + unknown[0]);

const mock = opt("--mock");
const out = opt("--out") ?? join(here, "index.html");
const corePath = mock ?? join(here, "src", "shamir-core.js");
const templatePath = join(here, "src", "app.template.html");

if (!existsSync(templatePath)) fail("missing " + templatePath);
if (!existsSync(corePath)) fail("missing core file " + corePath);

const template = readFileSync(templatePath, "utf8");
const core = readFileSync(corePath, "utf8");

const count = template.split(PLACEHOLDER).length - 1;
if (count !== 1) fail("template must contain the placeholder " + PLACEHOLDER + " exactly once, found " + count);
if (/<\/script/i.test(core)) fail("the core contains '</script' and would end the script tag early");

// A function replacer keeps '$' sequences in the core from being treated as patterns.
const html = template.replace(PLACEHOLDER, () => core.replace(/\s+$/, ""));
writeFileSync(out, html);
console.log("wrote " + out + " (" + html.length + " bytes)" + (mock ? " with MOCK core, do not commit" : ""));
