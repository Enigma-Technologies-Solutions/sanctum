#!/usr/bin/env node
// Writes the monogram icon into an example tool's source page.
//
//   node scripts/gen-example-icon.mjs            all examples
//   node scripts/gen-example-icon.mjs shamir     one example
//   node scripts/gen-example-icon.mjs --print otp-vault   print the SVG, change nothing
//
// The icon is an inline data: SVG in <link rel="icon">, so the page stays one file and
// Sanctum's scanner reads it as the tool icon. Edit the table below to add an example.
// Shamir's index.html is generated: run `node examples/shamir/build.mjs` after this
// (scripts/resign-examples.sh does both).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXAMPLES = {
  "otp-vault": { text: "otp", file: "examples/otp-vault/index.html" },
  shamir: { text: "sss", file: "examples/shamir/src/app.template.html" },
};

// Same construction as Confiel's favicon (rounded tile, inset outline, lowercase letters),
// in Enigma colours: ink tile, volt outline, white letters, volt square as the accent.
export function monogramSvg(text) {
  if (!/^[a-z]{2,3}$/.test(text)) throw new Error(`monogram must be 2 or 3 lowercase letters: ${text}`);
  const size = text.length === 3 ? 10 : 12;
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' width='32' height='32'>` +
    `<rect width='32' height='32' rx='6' fill='#0A0A0A'/>` +
    `<rect x='3' y='3' width='26' height='26' rx='5' fill='none' stroke='#FBFF00' stroke-width='1.5'/>` +
    `<text x='16' y='20.5' text-anchor='middle' font-family='Poppins,Helvetica,Arial,sans-serif' ` +
    `font-size='${size}' font-weight='700' fill='#FFFFFF' letter-spacing='-0.3'>${text}</text>` +
    `</svg>`
  );
}

// Percent-encode only what a double-quoted href needs. Single quotes stay as they are.
const dataUri = (svg) =>
  "data:image/svg+xml," + svg.replace(/[<>#%"]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));

const args = process.argv.slice(2);
const print = args[0] === "--print";
const names = (print ? args.slice(1) : args).length ? (print ? args.slice(1) : args) : Object.keys(EXAMPLES);

for (const name of names) {
  const ex = EXAMPLES[name];
  if (!ex) { console.error(`Unknown example '${name}'. Known: ${Object.keys(EXAMPLES).join(", ")}`); process.exit(1); }
  const svg = monogramSvg(ex.text);
  if (print) { console.log(svg); continue; }
  const path = join(root, ex.file);
  const html = readFileSync(path, "utf8");
  const tag = `<link rel="icon" href="${dataUri(svg)}">`;
  const re = /<link\s+rel="icon"\s+href="[^"]*">/;
  if (!re.test(html)) throw new Error(`${ex.file}: no <link rel="icon" href="..."> line to replace`);
  const next = html.replace(re, () => tag);
  if (next === html) console.log(`${name}: icon already current`);
  else { writeFileSync(path, next); console.log(`${name}: wrote "${ex.text}" icon to ${ex.file}`); }
}
