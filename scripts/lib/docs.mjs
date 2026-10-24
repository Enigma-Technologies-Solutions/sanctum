// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Guides that live in docs/ and are also published on the site. The Markdown in docs/ is the
// only source: the page under web/docs/ is generated from it, so the two cannot drift. Same
// rules as the rest of the site: zero JavaScript, strict CSP, no em or en dashes, and the
// strict Markdown subset the registry manuals use (no raw HTML, no images, no relative links).

import { renderMarkdown } from './markdown.mjs';
import { shell } from './site.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BEGIN = '<!-- docs:begin -->';
const END = '<!-- docs:end -->';

export class DocError extends Error {}

/** The guides published on the site. `src` is under docs/, `slug` is the path under /docs/. */
export const GUIDES = [
  {
    src: 'run-your-own-registry.md',
    slug: 'run-your-own-registry',
    updated: '2026-10-24',
    description: 'Make, sign, host and add your own registry of Sanctum tools, step by step.',
  },
];

export function guidePage(guide, markdown, { siteUrl }) {
  if (/[–—]/.test(markdown)) throw new DocError(`${guide.src}: remove em and en dashes; rewrite the sentence`);
  const m = /^# (.+)\n\n/.exec(markdown);
  if (!m) throw new DocError(`${guide.src}: must start with "# Title" and a blank line`);
  const title = m[1];
  const html = renderMarkdown(markdown.slice(m[0].length));
  const body = `    <article class="blog blog--post">
    <p class="eyebrow">Guide</p>
    <h1 class="h2 blog__h1">${esc(title)}</h1>
    <div class="manual blog__body">
${html}
    </div>
    <p class="blog__back"><a href="https://github.com/Enigma-Technologies-Solutions/sanctum/blob/main/docs/${esc(guide.src)}" rel="noopener">Read this guide on GitHub</a></p>
    </article>`;
  return shell({
    title: `${title} | Sanctum`,
    description: guide.description,
    canonical: `${siteUrl}/docs/${guide.slug}/`,
    depth: 3,
    siteUrl,
    body,
  });
}

export function docsSitemap(xml, guides, { siteUrl }) {
  const b = xml.indexOf(BEGIN);
  const e = xml.indexOf(END);
  if (b < 0 || e < b) throw new DocError('web/sitemap.xml has no docs:begin / docs:end markers');
  const entries = guides.map(
    (g) => `  <url>\n    <loc>${esc(`${siteUrl}/docs/${g.slug}/`)}</loc>\n    <lastmod>${g.updated}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.5</priority>\n  </url>`,
  );
  return `${xml.slice(0, b)}${BEGIN}${entries.length ? `\n${entries.join('\n')}` : ''}\n  ${xml.slice(e)}`;
}

/** Every file the guides produce, keyed by path under web/docs/. */
export function renderDocs(read, { siteUrl }) {
  const files = new Map();
  for (const g of GUIDES) files.set(`${g.slug}/index.html`, guidePage(g, read(g.src), { siteUrl }));
  return files;
}
