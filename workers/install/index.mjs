// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions

// enigmahq.sh/install/<app_id>: a link that works anywhere a normal web link works.
//
// Email clients, chat apps and Markdown viewers often strip or block a sanctum:// link. This
// worker gives them an https address instead. It serves one small static page with a button
// that opens Sanctum, and a way to get Sanctum if it is not installed.
//
// It has no state, calls no other service and never installs anything: opening Sanctum shows
// the user a confirmation, and only a click there goes on (docs/deep-link.md). Whatever is in
// the address beyond a valid app id is ignored and never written into the page.

const APP_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const MAX_APP_ID = 100;
const RELEASES = 'https://github.com/Enigma-Technologies-Solutions/sanctum/releases/latest';
const SITE = 'https://sanctum.enigma.sh';
const CSS_PATH = '/_/install.css';

const CSS = `
:root { color-scheme: light dark; --bg: #fff; --ink: #0a0a0a; --ink-2: #565b62; --line: #e3e7ec; --volt: #fbff00; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0c0e; --ink: #f2f3f5; --ink-2: #a3a9b1; --line: #2a2e34; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 4rem 1.25rem; }
h1 { font-size: 1.6rem; line-height: 1.2; margin: 0 0 .5rem; }
.bar { width: 3rem; height: .5rem; background: var(--volt); margin: 0 0 1.25rem; }
p { color: var(--ink-2); margin: 0 0 1rem; }
code { font: .9em ui-monospace, monospace; color: var(--ink); overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.5rem 0; }
.btn { display: inline-block; padding: .65rem 1.1rem; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); text-decoration: none; font-weight: 600; }
.btn--volt { background: var(--volt); border-color: var(--volt); color: #0a0a0a; }
.btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.fine { font-size: .875rem; }
a { color: var(--ink); }
`;

const HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The app id in a request path, or null. Only a valid id gets through. */
export function appIdFromPath(pathname) {
  const m = /^\/install\/([^/]+)\/?$/.exec(pathname);
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return id.length <= MAX_APP_ID && APP_ID.test(id) ? id : null;
}

export function installUrl(appId) {
  return `sanctum://install?app=${encodeURIComponent(appId)}`;
}

function page(appId) {
  const link = installUrl(appId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Install in Sanctum</title>
<link rel="stylesheet" href="${CSS_PATH}">
</head>
<body>
<main>
  <h1>Install in Sanctum</h1>
  <div class="bar"></div>
  <p>This link is for the tool <code>${esc(appId)}</code>.</p>
  <div class="row">
    <a class="btn btn--volt" href="${esc(link)}">Open in Sanctum</a>
    <a class="btn" href="${SITE}/apps/${esc(appId)}/">About this tool</a>
  </div>
  <p class="fine">Sanctum opens, shows the tool and what it asks for, and waits for your click. Nothing is installed from this page, and the tool starts with no access.</p>
  <p class="fine">Nothing happened? Sanctum may not be installed. <a href="${RELEASES}" rel="noopener">Get Sanctum</a>, then use the button again.</p>
</main>
</body>
</html>
`;
}

function notFound() {
  return new Response('Not found\n', {
    status: 404,
    headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60' },
  });
}

/** The worker. Pure: a Request in, a Response out. */
export function handle(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed\n', {
      status: 405,
      headers: { ...HEADERS, allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const url = new URL(request.url);
  if (url.pathname === CSS_PATH) {
    return new Response(request.method === 'HEAD' ? null : CSS, {
      headers: { ...HEADERS, 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=86400' },
    });
  }
  const id = appIdFromPath(url.pathname);
  if (!id) return notFound();
  return new Response(request.method === 'HEAD' ? null : page(id), {
    headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
}

export default { fetch: (request) => handle(request) };
