// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Static pages for the registry: /apps/ and /apps/<app_id>/. Zero JavaScript, and the same
// strict CSP as the rest of the site. Everything shown comes from the registry files, so a
// page cannot say something the signed index does not.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSP =
  "default-src 'none'; script-src 'none'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const LABELS = { storage: 'Storage', smartcard: 'Smart card', net: 'Network' };

/** Human text for a declared capability list, as the approval screen would group it. */
export function describeAccess(declared) {
  const items = declared.map((c) => {
    if (typeof c === 'string') return LABELS[c] ?? c;
    const [k, v] = Object.entries(c)[0];
    const detail = Array.isArray(v) && v.length ? ` (${k === 'smartcard' ? 'applet' : 'host'} ${v.join(', ')})` : '';
    return `${LABELS[k] ?? k}${detail}`;
  });
  return items.length ? `Asks for: ${items.join(', ')}` : 'Asks for no special access';
}

const date = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

export function shell({ title, description, canonical, depth, body, image, ogType = 'website', siteUrl = 'https://sanctum.enigma.sh', head = '' }) {
  const up = '../'.repeat(depth);
  const img = image ? `${siteUrl}/${image}` : `${siteUrl}/assets/og.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="Sanctum">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="theme-color" content="#FFFFFF">
<meta name="color-scheme" content="light">
<link rel="icon" href="${up}assets/favicon.svg" type="image/svg+xml">
<link rel="icon" href="${up}favicon.ico" sizes="32x32 48x48">
<link rel="apple-touch-icon" href="${up}assets/apple-touch-icon.png">
${head}<link rel="stylesheet" href="${up}styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<nav class="nav" aria-label="Primary">
  <div class="wrap nav__inner">
    <a class="wordmark" href="${up}" aria-label="Sanctum home">SANCTUM<span class="wordmark__sq" aria-hidden="true"></span></a>
    <div class="nav__links">
      <a href="${up}">Home</a>
      <a href="${up}apps/">Signed tools</a>
      <a href="${up}blog/">Blog</a>
      <a href="${up}docs/">Docs</a>
    </div>
    <div class="nav__cta">
      <a class="btn btn--ghost btn--sm nav__gh" href="https://github.com/Enigma-Technologies-Solutions/sanctum" rel="noopener">GitHub</a>
      <a class="btn btn--volt btn--sm" href="https://github.com/Enigma-Technologies-Solutions/sanctum/releases/latest" rel="noopener">Download Sanctum</a>
    </div>
  </div>
</nav>

<main id="main" class="section apps">
  <div class="wrap">
${body}
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
}

const NOTE = `<p class="lede">Verified means the publisher is who it says and the bytes have not changed. It does not mean safe. A signature never grants access: every tool still starts with nothing approved, and you approve each capability yourself.</p>`;

function card(entry, depth) {
  const v = entry.versions[0];
  const up = '../'.repeat(depth);
  const name = entry.name;
  return `
      <article class="card app">
        <h2 class="app__name"><a href="./${esc(entry.app_id)}/">${esc(name)}</a> <span class="tag">v${esc(entry.latest)}</span></h2>
        <p class="app__desc">${esc(entry.summary)}</p>
        <p class="fine">${esc(describeAccess(v.declared))}</p>
        <p class="fine">Published by ${esc(entry.publisher.name)}</p>
        <a class="btn btn--volt btn--sm" href="${up}registry/v1/${esc(v.bundle.path)}" download>Download (${(v.bundle.size / 1024).toFixed(1)} KB)</a>
      </article>`;
}

function indexPage({ config, index, sitePages }) {
  const cards = sitePages.map((p) => card(p.entry, 1)).join('\n');
  const body = `    <p class="eyebrow">Signed tools</p>
    <h1 class="h2">Tools from Enigma</h1>
    <p class="lede">Each file below is signed by ${esc(config.name)}. Download it, then open it in Sanctum with Open, or drop it on the Library. Sanctum shows "Verified publisher" when the signature checks out.</p>
    ${NOTE}

    <div class="apps__list">${cards}
    </div>

    <h2 class="apps__sub">Check a download</h2>
    <p class="lede">Open a tool's page to see the file SHA-256. On macOS or Linux, run <code>shasum -a 256 &lt;file&gt;</code> in a terminal and compare. Sanctum also checks the signature itself when you open the file.</p>

    <h2 class="apps__sub">For tools and scripts</h2>
    <p class="lede">The same catalogue is published as signed files: <a href="../registry/v1/index.json"><code>index.json</code></a> with its <a href="../registry/v1/index.json.sig"><code>signature</code></a>. Registry <code>${esc(index.id)}</code>, serial ${index.serial}.</p>`;
  return shell({
    title: 'Signed tools for Sanctum',
    description: `Single-file tools signed by ${config.name}. Download a .sanctum file and open it in Sanctum.`,
    canonical: `${config.site_url}/apps/`,
    depth: 1,
    body,
  });
}

const CHANGE_LABEL = { added: 'Added', changed: 'Changed', fixed: 'Fixed', security: 'Security', removed: 'Removed' };

/** The link that opens Sanctum's install confirmation (src-tauri/src/registry/link.rs). */
export function installLink(appId) {
  return `sanctum://install?app=${encodeURIComponent(appId)}`;
}

function appPage({ config, entry, detail, manualHtml }) {
  const id = entry.app_id;
  const v = entry.versions[0];
  const reg = '../../registry/v1/';
  const hashes = `        <dl class="app__hashes fine">
          <dt>File SHA-256</dt><dd>${esc(v.bundle.sha256.slice('sha256:'.length))}</dd>
          <dt>Tool SHA-256</dt><dd>${esc(v.checksum.slice('sha256:'.length))}</dd>
          <dt>App id</dt><dd>${esc(id)}</dd>
          <dt>Publisher key</dt><dd>${esc(entry.publisher.keyid)}</dd>
        </dl>`;
  const changelog = detail.changelog
    .map(
      (c) => `      <section>
        <h3 class="changes__v">${esc(c.version)} <span class="fine">${esc(c.date)}</span></h3>
        <ul class="changes__list">${c.changes.map((x) => `<li><strong>${CHANGE_LABEL[x.type]}.</strong> ${esc(x.text)}</li>`).join('')}</ul>
      </section>`,
    )
    .join('\n');
  const shots = (detail.screenshots ?? [])
    .map((s) => `      <figure class="screenshot"><img src="${reg}${esc(s.path)}" width="${s.width}" height="${s.height}" alt="${esc(s.alt)}" loading="lazy"></figure>`)
    .join('\n');
  const links = [
    detail.homepage && `<a href="${esc(detail.homepage)}" rel="noopener">Website</a>`,
    detail.source && `<a href="${esc(detail.source)}" rel="noopener">Source</a>`,
    detail.license && `<span>${esc(detail.license)}</span>`,
  ].filter(Boolean);

  const body = `    <div class="appdoc">
    <p class="eyebrow"><a href="../">Signed tools</a></p>
    <h1 class="appdoc__title">${esc(entry.name)} <span class="tag">v${esc(entry.latest)}</span></h1>
    <p class="lede appdoc__lede">${esc(entry.summary)}</p>

    <article class="card app">
        <p class="app__desc">${esc(detail.description)}</p>
        <p class="fine">${esc(describeAccess(v.declared))}</p>
        <p class="fine appdoc__links">Published by ${esc(entry.publisher.name)}${links.length ? ` · ${links.join(' · ')}` : ''}</p>
${hashes}
        <div class="btn-row">
          <a class="btn btn--volt btn--sm" href="${esc(installLink(id))}">Install in Sanctum</a>
          <a class="btn btn--ghost btn--sm" href="${reg}${esc(v.bundle.path)}" download>Download file (${(v.bundle.size / 1024).toFixed(1)} KB)</a>
        </div>
        <p class="fine">Install opens Sanctum, which shows this tool and what it asks for, then waits for your click. Nothing is installed from the page itself. Sanctum not installed? <a href="https://github.com/Enigma-Technologies-Solutions/sanctum/releases/latest" rel="noopener">Get Sanctum</a> first.</p>
    </article>
    <p class="notice">Verified means the publisher is who it says and the bytes have not changed. It does not mean safe. A signature never grants access: every tool still starts with nothing approved, and you approve each capability yourself.</p>
${shots ? `\n    <h2 class="apps__sub">Screenshots</h2>\n${shots}\n` : ''}
    <h2 class="apps__sub">What is new</h2>
    <div class="changes">
${changelog}
    </div>
${manualHtml ? `\n    <h2 class="apps__sub">Manual</h2>\n    <div class="manual">\n${manualHtml}\n    </div>\n` : ''}
    <h2 class="apps__sub">For tools and scripts</h2>
    <p class="lede"><a href="${reg}${esc(entry.detail.path)}"><code>${esc(entry.detail.path)}</code></a> holds this page's data. It is pinned by hash in the signed <a href="${reg}index.json"><code>index.json</code></a>.</p>
    </div>`;
  return shell({
    title: `${entry.name}, a signed tool for Sanctum`,
    description: entry.summary,
    canonical: `${config.site_url}/apps/${id}/`,
    depth: 2,
    image: `apps/${id}/og.png`,
    siteUrl: config.site_url,
    body,
  });
}

/** Pages keyed by path under web/apps/. */
export function renderSite(build) {
  const out = new Map();
  out.set('index.html', Buffer.from(indexPage(build)));
  for (const p of build.sitePages) {
    out.set(`${p.entry.app_id}/index.html`, Buffer.from(appPage({ config: build.config, ...p })));
  }
  return out;
}

const BEGIN = '  <!-- registry:begin -->';
const END = '  <!-- registry:end -->';

/** Replace the marked block of sitemap.xml with one entry per page. */
export function renderSitemap(xml, build) {
  const b = xml.indexOf(BEGIN);
  const e = xml.indexOf(END);
  if (b < 0 || e < b) throw new Error('web/sitemap.xml has no registry:begin / registry:end markers');
  const newest = Math.max(...build.sitePages.flatMap((p) => p.entry.versions.map((v) => v.published_at)));
  const url = (loc, lastmod, priority) =>
    `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  const entries = [
    url(`${build.config.site_url}/apps/`, date(newest), '0.5'),
    ...build.sitePages.map((p) =>
      url(`${build.config.site_url}/apps/${p.entry.app_id}/`, date(Math.max(...p.entry.versions.map((v) => v.published_at))), '0.4'),
    ),
  ];
  return `${xml.slice(0, b)}${BEGIN}\n${entries.join('\n')}\n${xml.slice(e)}`;
}
