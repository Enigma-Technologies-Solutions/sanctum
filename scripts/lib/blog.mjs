// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// The blog: blog-src/<date>-<slug>.md becomes /blog/, /blog/<slug>/ and /blog/feed.xml.
// Same rules as the rest of the site: zero JavaScript, strict CSP, no em or en dashes in
// copy, and the strict Markdown subset the registry manuals use (no raw HTML, no images).
// A post with `draft: "true"` is never written to web/; preview it with --preview DIR.

import { renderMarkdown } from './markdown.mjs';
import { shell } from './site.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export class PostError extends Error {}

/** Minimal `key: "value"` frontmatter, the only form blog-src uses. */
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new PostError('post has no frontmatter');
  const data = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = /^([a-z_]+):\s*"(.*)"\s*$/.exec(line);
    if (!kv) throw new PostError(`frontmatter line is not key: "value": ${line.slice(0, 40)}`);
    data[kv[1]] = kv[2];
  }
  return { data, body: m[2] };
}

const KNOWN = new Set(['title', 'date', 'slug', 'excerpt', 'draft', 'kicker', 'cover_title', 'cover_sub']);

/** Validate one post file. Returns { ...data, draft: boolean, html }. */
export function parsePost(file, text) {
  const { data, body } = frontmatter(text);
  const where = `${file}:`;
  for (const k of Object.keys(data)) if (!KNOWN.has(k)) throw new PostError(`${where} unknown key ${k}`);
  for (const k of ['title', 'date', 'slug', 'excerpt']) if (!data[k]) throw new PostError(`${where} missing ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || Number.isNaN(Date.parse(`${data.date}T00:00:00Z`))) throw new PostError(`${where} date must be YYYY-MM-DD`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.slug)) throw new PostError(`${where} slug must be lower-case words joined by hyphens`);
  if (file !== `${data.date}-${data.slug}.md`) throw new PostError(`${where} file name must be ${data.date}-${data.slug}.md`);
  if (data.title.length > 90) throw new PostError(`${where} title is over 90 characters`);
  if (data.excerpt.length > 220) throw new PostError(`${where} excerpt is over 220 characters`);
  if (data.draft !== undefined && data.draft !== 'true') throw new PostError(`${where} draft must be "true" or absent`);
  for (const [k, v] of Object.entries(data)) if (/[\u2013\u2014]/.test(v)) throw new PostError(`${where} ${k} has an em or en dash; rewrite the sentence`);
  if (/[\u2013\u2014]/.test(body)) throw new PostError(`${where} body has an em or en dash; rewrite the sentence`);
  let html;
  try {
    html = renderMarkdown(body);
  } catch (e) {
    throw new PostError(`${where} ${e.message}`);
  }
  return { ...data, draft: data.draft === 'true', html };
}

const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function indexPage(posts, { siteUrl }) {
  const items = posts
    .map(
      (p) => `      <article class="blog__item">
        <a class="blog__thumb" href="./${esc(p.slug)}/" tabindex="-1" aria-hidden="true"><img src="./${esc(p.slug)}/thumb.png" width="600" height="400" alt="" loading="lazy"></a>
        <p class="blog__date">${esc(longDate(p.date))}</p>
        <h2 class="blog__title"><a href="./${esc(p.slug)}/">${esc(p.title)}</a></h2>
        <p class="blog__excerpt">${esc(p.excerpt)}</p>
        <a class="blog__more" href="./${esc(p.slug)}/">Read more</a>
      </article>`,
    )
    .join('\n');
  const body = `    <div class="blog">
    <p class="eyebrow">Blog</p>
    <h1 class="h2">News</h1>
${posts.length ? `    <div class="blog__list">\n${items}\n    </div>` : '    <p class="lede">Coming soon.</p>'}
    </div>`;
  return shell({
    title: 'Sanctum blog',
    description: 'News about Sanctum, the desktop sandbox for HTML tools that AI models write.',
    canonical: `${siteUrl}/blog/`,
    depth: 1,
    siteUrl,
    head: `<link rel="alternate" type="application/atom+xml" title="Sanctum blog" href="feed.xml">\n`,
    body,
  });
}

export function postPage(post, { siteUrl }) {
  const body = `    <article class="blog blog--post">
    <p class="eyebrow"><a href="../">Blog</a>${post.draft ? ' · draft' : ''}</p>
    <p class="blog__date">${esc(longDate(post.date))}</p>
    <h1 class="h2 blog__h1">${esc(post.title)}</h1>
    <figure class="blog__cover"><img src="./cover.png" width="1200" height="630" alt=""></figure>
    <div class="manual blog__body">
${post.html}
    </div>
    <p class="blog__back"><a href="../">Back to the blog</a></p>
    </article>`;
  return shell({
    title: `${post.title} | Sanctum`,
    description: post.excerpt,
    canonical: `${siteUrl}/blog/${post.slug}/`,
    depth: 2,
    siteUrl,
    image: `blog/${post.slug}/cover.png`,
    ogType: 'article',
    body,
  });
}

export function feed(posts, { siteUrl }) {
  const updated = posts.length ? `${posts[0].date}T12:00:00Z` : '2026-01-01T00:00:00Z';
  const entries = posts
    .map(
      (p) => `  <entry>
    <title>${esc(p.title)}</title>
    <link href="${siteUrl}/blog/${esc(p.slug)}/"/>
    <id>${siteUrl}/blog/${esc(p.slug)}/</id>
    <updated>${p.date}T12:00:00Z</updated>
    <summary>${esc(p.excerpt)}</summary>
  </entry>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sanctum blog</title>
  <link href="${siteUrl}/blog/feed.xml" rel="self"/>
  <link href="${siteUrl}/blog/"/>
  <id>${siteUrl}/blog/</id>
  <updated>${updated}</updated>
  <author><name>Enigma Technologies Solutions</name></author>
${entries}
</feed>
`;
}

const BEGIN = '<!-- blog:begin -->';
const END = '<!-- blog:end -->';

export function blogSitemap(xml, posts, { siteUrl }) {
  const b = xml.indexOf(BEGIN);
  const e = xml.indexOf(END);
  if (b < 0 || e < b) throw new PostError('web/sitemap.xml has no blog:begin / blog:end markers');
  const url = (loc, lastmod, priority) => `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  const entries = posts.length
    ? [url(`${siteUrl}/blog/`, posts[0].date, '0.6'), ...posts.map((p) => url(`${siteUrl}/blog/${p.slug}/`, p.date, '0.5'))]
    : [];
  return `${xml.slice(0, b)}${BEGIN}${entries.length ? `\n${entries.join('\n')}` : ''}\n  ${xml.slice(e)}`;
}

/** Every file the blog produces, keyed by path under web/blog/. Posts newest first. */
export function renderBlog(allPosts, { siteUrl, includeDrafts = false }) {
  const posts = allPosts.filter((p) => includeDrafts || !p.draft).sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  const seen = new Set();
  for (const p of posts) {
    if (seen.has(p.slug)) throw new PostError(`duplicate slug ${p.slug}`);
    seen.add(p.slug);
  }
  const out = new Map();
  out.set('index.html', indexPage(posts, { siteUrl }));
  for (const p of posts) out.set(`${p.slug}/index.html`, postPage(p, { siteUrl }));
  out.set('feed.xml', feed(posts.filter((p) => !p.draft), { siteUrl }));
  return { files: out, posts };
}
