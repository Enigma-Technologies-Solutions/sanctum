// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Inlines the Enigma tool kit into a tool's template. Every tool's build.mjs calls applyKit,
// so a change to kit.css, kit.js or icons.svg reaches every tool on its next build.
//
// A template marks three places, each exactly once:
//   /*__KIT_CSS__*/     inside <style>: the tokens, the components and the embedded fonts
//   <!--__KIT_ICONS__-->  right after <body>: the shared Lucide symbols (#i-sun, #i-copy, ...)
//   /*__KIT_JS__*/      inside a <script>: the theme switch
//
// The fonts are the app's own files (src/assets/fonts), embedded as data: URIs, so the tool
// makes no request. The tool's CSP needs `font-src data:` for them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FONT_DIR = join(here, "..", "..", "src", "assets", "fonts");

const FONTS = [
  { family: "Inter", weight: "100 900", file: "Inter-var.woff2" },
  { family: "Poppins", weight: "700", file: "Poppins-700.woff2" },
  { family: "Poppins", weight: "800", file: "Poppins-800.woff2" },
  { family: "Space Mono", weight: "400", file: "SpaceMono-400.woff2" },
  { family: "Space Mono", weight: "700", file: "SpaceMono-700.woff2" },
];

export const PLACEHOLDERS = {
  css: "/*__KIT_CSS__*/",
  icons: "<!--__KIT_ICONS__-->",
  js: "/*__KIT_JS__*/",
};

// Strings that Sanctum's scanner (src-tauri/src/commands/scan.rs) or the examples workflow
// treats as a capability or a risk. The kit must contain none of them, so inlining it never
// changes what a tool asks for. Built from pieces so this file does not trip a grep itself.
export const FORBIDDEN = [
  "getUserMedia", "navigator.usb", "navigator.serial", "navigator.hid", "navigator.bluetooth",
  "navigator.geolocation", "getCurrentPosition", "watchPosition", "Notification",
  "local" + "Storage", "session" + "Storage", "indexed" + "DB", "Indexed" + "DB", "caches.open", "Cache" + "Storage",
  "fetch(", "fetch (", "XMLHttp" + "Request", "new Web" + "Socket", "new EventSource",
  "sanctum.smartcard", "sanctum[\"smartcard\"]", "http" + "://", "https" + "://",
  "Math.random", "eval(", "new Function", "importScripts", "new Worker", "document.cookie",
];

/** The forbidden strings found in `text`, ignoring the SVG namespace the scanner also ignores. */
export function findForbidden(text) {
  const t = text.replace(/xmlns\s*=\s*(?:"http:\/\/www\.w3\.org\/2000\/svg"|'http:\/\/www\.w3\.org\/2000\/svg')/g, "");
  return FORBIDDEN.filter((s) => t.includes(s));
}

function fontFaces() {
  return FONTS.map(({ family, weight, file }) => {
    const b64 = readFileSync(join(FONT_DIR, file)).toString("base64");
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  }).join("\n");
}

/** The three pieces of the kit, ready to inline. */
export function kitParts() {
  const css = readFileSync(join(here, "kit.css"), "utf8").replace("/*__KIT_FONTS__*/", () => fontFaces()).trim();
  const js = readFileSync(join(here, "kit.js"), "utf8").trim();
  const icons = readFileSync(join(here, "icons.svg"), "utf8").replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  for (const [name, text] of Object.entries({ css, js, icons })) {
    const bad = findForbidden(text);
    if (bad.length) throw new Error(`kit ${name} contains ${bad.join(", ")}; the kit must add no capability`);
  }
  if (/<\/script/i.test(js)) throw new Error("kit.js contains '</script'");
  if (/<\/style/i.test(css)) throw new Error("kit.css contains '</style'");
  return { css, js, icons };
}

/** Replace the kit placeholders in `template`. Throws if one is missing or repeated. */
export function applyKit(template) {
  const parts = kitParts();
  let html = template;
  for (const key of ["css", "icons", "js"]) {
    const mark = PLACEHOLDERS[key];
    const count = html.split(mark).length - 1;
    if (count !== 1) throw new Error(`template must contain ${mark} exactly once, found ${count}`);
    // A function replacer keeps '$' sequences in the kit from being read as patterns.
    html = html.replace(mark, () => parts[key]);
  }
  const ids = [...html.matchAll(/<symbol\s+id="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new Error(`icon id defined twice: ${[...new Set(dup)].join(", ")}; the kit already has it`);
  return html;
}
