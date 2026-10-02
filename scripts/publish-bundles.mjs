#!/usr/bin/env node
// Copies the newest signed bundle of each example into web/apps/ and rewrites the download
// page web/apps/index.html. Run it after scripts/resign-examples.sh, then commit web/apps/.
//
//   node scripts/publish-bundles.mjs
//
// It refuses to publish a bundle unless the signature is valid, the file hash matches, and
// the certificate chains to the Enigma root compiled into the app (src-tauri/src/trust.rs).
// The site deploys from main through .github/workflows/pages.yml; this script never pushes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "web", "apps");
const cli = join(root, "src-tauri/crates/sanctum-bundle/Cargo.toml");

const anchorId = /"(ed25519:[A-Za-z0-9_-]+)",\s*"Enigma Technologies Solutions"/.exec(
  readFileSync(join(root, "src-tauri/src/trust.rs"), "utf8"),
)?.[1];
if (!anchorId) throw new Error("could not find the Enigma root key in trust.rs");

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const semver = (v) => v.split(".").map(Number);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// Newest bundle per app id, across examples/*/.
const found = new Map();
for (const dir of readdirSync(join(root, "examples"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of readdirSync(join(root, "examples", dir.name))) {
    const m = /^(.+)-(\d+\.\d+\.\d+)\.sanctum$/.exec(f);
    if (!m) continue;
    const cur = found.get(m[1]);
    if (!cur || newer(m[2], cur.version) > 0) found.set(m[1], { appId: m[1], version: m[2], path: join(root, "examples", dir.name, f), file: f });
  }
}
if (!found.size) throw new Error("no .sanctum files under examples/. Run scripts/resign-examples.sh first.");

mkdirSync(outDir, { recursive: true });
const apps = [];
for (const b of [...found.values()].sort((a, c) => a.appId.localeCompare(c.appId))) {
  const out = execFileSync("cargo", ["run", "-q", "--manifest-path", cli, "--", "verify", b.path, "--anchor", `${anchorId}=Enigma Technologies Solutions`], { encoding: "utf8" });
  const field = (k) => new RegExp(`^${k}\\s+(.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
  if (!/^valid/.test(field("signature")) || !/^matches/.test(field("file hash")) || !/^anchored/.test(field("trust"))) {
    throw new Error(`${b.file}: not publishable (needs a valid signature, matching hash and the Enigma root)\n${out}`);
  }
  const bytes = readFileSync(b.path);
  const html = JSON.parse(bytes.toString("utf8")).html;
  const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
  copyFileSync(b.path, join(outDir, b.file));
  apps.push({
    ...b,
    name: field("name"),
    description,
    declared: field("declared"),
    toolHash: field("file hash").replace(/^matches\s+/, ""),
    fileSha: createHash("sha256").update(bytes).digest("hex"),
    kb: (bytes.length / 1024).toFixed(1),
  });
  console.log(`${b.file}: verified, copied`);
}

// `declared` is JSON such as ["storage",{"smartcard":["a0000005272101"]}].
const LABELS = { storage: "Storage", smartcard: "Smart card" };
const access = (d) => {
  const items = JSON.parse(d || "[]").map((c) => {
    if (typeof c === "string") return LABELS[c] ?? c;
    const [k, v] = Object.entries(c)[0];
    return `${LABELS[k] ?? k} (applet ${v.join(", ")})`;
  });
  return items.length ? `Asks for: ${esc(items.join(", "))}` : "Asks for no special access";
};

const cards = apps.map((a) => `
      <article class="card app">
        <h2 class="app__name">${esc(a.name)} <span class="tag">v${a.version}</span></h2>
        <p class="app__desc">${esc(a.description)}</p>
        <p class="fine">${access(a.declared)}</p>
        <dl class="app__hashes fine">
          <dt>File SHA-256</dt><dd>${a.fileSha}</dd>
          <dt>Tool SHA-256</dt><dd>${esc(a.toolHash)}</dd>
          <dt>App id</dt><dd>${esc(a.appId)}</dd>
        </dl>
        <a class="btn btn--volt btn--sm" href="./${esc(a.file)}" download>Download ${esc(a.file)} (${a.kb} KB)</a>
      </article>`).join("\n");

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed tools for Sanctum</title>
<meta name="description" content="Single-file tools signed by Enigma Technologies Solutions. Download a .sanctum file and open it in Sanctum.">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="canonical" href="https://sanctum.enigma.sh/apps/">
<meta name="theme-color" content="#0A0A09">
<meta name="color-scheme" content="dark">
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<nav class="nav" aria-label="Primary">
  <div class="wrap nav__inner">
    <a class="wordmark" href="../" aria-label="Sanctum home">SANCTUM<span class="wordmark__sq" aria-hidden="true"></span></a>
    <div class="nav__cta">
      <a class="btn btn--ghost btn--sm nav__gh" href="https://github.com/Enigma-Technologies-Solutions/sanctum" rel="noopener">GitHub</a>
      <a class="btn btn--volt btn--sm" href="https://github.com/Enigma-Technologies-Solutions/sanctum/releases/latest" rel="noopener">Download Sanctum</a>
    </div>
  </div>
</nav>

<main id="main" class="section apps">
  <div class="wrap">
    <p class="eyebrow">Signed tools</p>
    <h1 class="h2">Tools from Enigma</h1>
    <p class="lede">Each file below is signed by Enigma Technologies Solutions. Download it, then open it in Sanctum with Open, or drop it on the Library. Sanctum shows "Verified publisher" when the signature checks out.</p>
    <p class="lede">Verified means the publisher is who it says and the bytes have not changed. It does not mean safe. A signature never grants access: every tool still starts with nothing approved, and you approve each capability yourself.</p>

    <div class="apps__list">${cards}
    </div>

    <h2 class="apps__sub">Check a download</h2>
    <p class="lede">Compare the file hash with the one on its card. On macOS or Linux, run <code>shasum -a 256 &lt;file&gt;</code> in a terminal. Sanctum also checks the signature itself when you open the file.</p>
  </div>
</main>

<footer class="foot">
  <div class="wrap">
    <div class="foot__bar">
      <span class="ets" aria-hidden="true">ETS</span>
      <span>© 2026 Enigma Technologies Solutions</span>
      <span class="foot__bar-sp">AGPL-3.0-only</span>
    </div>
  </div>
</footer>
</body>
</html>
`;
writeFileSync(join(outDir, "index.html"), page);
console.log(`wrote web/apps/index.html (${apps.length} tools)`);
