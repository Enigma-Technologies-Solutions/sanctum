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
  {
    src: 'white-label.md',
    slug: 'white-label',
    updated: '2026-10-25',
    description: 'Fork Sanctum into a build with your own name, colours, trust keys and registry.',
  },
];

/** The title of a guide: its first line, `# Title`. Dashes are refused here, once, for every guide. */
export function guideTitle(guide, markdown) {
  if (/[\u2013\u2014]/.test(markdown)) throw new DocError(`${guide.src}: remove em and en dashes; rewrite the sentence`);
  const m = /^# (.+)\n\n/.exec(markdown);
  if (!m) throw new DocError(`${guide.src}: must start with "# Title" and a blank line`);
  return { title: m[1], rest: markdown.slice(m[0].length) };
}

export function guidePage(guide, markdown, { siteUrl }) {
  const { title, rest } = guideTitle(guide, markdown);
  const html = renderMarkdown(rest);
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
    depth: 2,
    siteUrl,
    body,
  });
}

/** /docs/: one card for each guide. */
export function indexPage(guides, read, { siteUrl }) {
  const items = guides
    .map((g) => {
      const { title } = guideTitle(g, read(g.src));
      return `      <li class="blog__item">
        <h2 class="blog__title"><a href="./${esc(g.slug)}/">${esc(title)}</a></h2>
        <p class="blog__excerpt">${esc(g.description)}</p>
        <a class="blog__more" href="./${esc(g.slug)}/">Read the guide</a>
      </li>`;
    })
    .join('\n');
  const body = `    <div class="blog">
    <p class="eyebrow">Docs</p>
    <h1 class="h2 blog__h1">Guides</h1>
    <p class="blog__excerpt">Step by step guides for running Sanctum with your own registry and your own branding. The full design notes live in the <a href="https://github.com/Enigma-Technologies-Solutions/sanctum/tree/main/docs" rel="noopener">docs folder</a> of the repository.</p>
    <ul class="blog__list">
${items}
    </ul>
    </div>`;
  return shell({
    title: 'Docs | Sanctum',
    description: 'Guides for running Sanctum with your own registry and your own branding.',
    canonical: `${siteUrl}/docs/`,
    depth: 1,
    siteUrl,
    body,
  });
}

export function docsSitemap(xml, guides, { siteUrl }) {
  const b = xml.indexOf(BEGIN);
  const e = xml.indexOf(END);
  if (b < 0 || e < b) throw new DocError('web/sitemap.xml has no docs:begin / docs:end markers');
  const url = (loc, lastmod, priority) => `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  const entries = [
    url(`${siteUrl}/docs/`, guides.map((g) => g.updated).sort().at(-1), '0.6'),
    ...guides.map((g) => url(`${siteUrl}/docs/${g.slug}/`, g.updated, '0.5')),
  ];
  return `${xml.slice(0, b)}${BEGIN}${entries.length ? `\n${entries.join('\n')}` : ''}\n  ${xml.slice(e)}`;
}

/** Every file the guides produce, keyed by path under web/docs/. */
export function renderDocs(read, { siteUrl }) {
  const files = new Map();
  files.set('index.html', indexPage(GUIDES, read, { siteUrl }));
  for (const g of GUIDES) files.set(`${g.slug}/index.html`, guidePage(g, read(g.src), { siteUrl }));
  return files;
}
