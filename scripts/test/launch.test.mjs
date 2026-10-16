// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// The launch surface: the blog generator, the brand images and the home page's promises.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostError, blogSitemap, feed, parsePost, renderBlog } from '../lib/blog.mjs';
import { installLink } from '../lib/site.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = join(repo, 'web');
const SITE = 'https://sanctum.enigma.sh';

const post = (over = {}, body = 'Hello **world**.\n') => {
  const d = { title: 'A title', date: '2026-10-16', slug: 'a-title', excerpt: 'An excerpt.', ...over };
  const fm = Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: "${v}"`).join('\n');
  return [`${d.date}-${d.slug}.md`, `---\n${fm}\n---\n${body}`];
};
const parse = (over, body) => parsePost(...post(over, body));
const png = (f) => {
  const b = readFileSync(f);
  assert.equal(b.subarray(1, 4).toString(), 'PNG', `${f} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

// ── Blog generator ───────────────────────────────────────────────────────────

test('a valid post parses and renders its Markdown', () => {
  const p = parse();
  assert.equal(p.slug, 'a-title');
  assert.equal(p.draft, false);
  assert.match(p.html, /<strong>world<\/strong>/);
});

test('bad posts are refused, each for its own reason', () => {
  const bad = [
    [{ title: undefined }, /missing title/],
    [{ excerpt: undefined }, /missing excerpt/],
    [{ date: '2026-13-40' }, /date must be/],
    [{ date: '16-10-2026' }, /date must be/],
    [{ date: '+002026-10-16' }, /date must be/],
    [{ date: '2026-10-1' }, /date must be/],
    [{ slug: 'Bad Slug' }, /slug must be/],
    [{ slug: '../etc' }, /slug must be/],
    [{ title: 'x'.repeat(91) }, /over 90/],
    [{ excerpt: 'x'.repeat(221) }, /over 220/],
    [{ draft: 'yes' }, /draft must be/],
    [{ extra: 'x' }, /unknown key extra/],
    [{ title: 'One — two' }, /em or en dash/],
    [{ excerpt: 'One – two' }, /em or en dash/],
  ];
  for (const [over, re] of bad) assert.throws(() => parse(over), (e) => e instanceof PostError && re.test(e.message), JSON.stringify(over));
  assert.throws(() => parse({}, 'a — b'), /em or en dash/);
  assert.throws(() => parse({}, '<script>alert(1)</script>'), /raw HTML/);
  assert.throws(() => parse({}, '![x](https://example.com/a.png)'), /images/);
  assert.throws(() => parse({}, '[x](javascript:alert(1))'), /link/);
  assert.throws(() => parsePost('wrong-name.md', post()[1]), /file name must be/);
  assert.throws(() => parsePost('x.md', 'no frontmatter'), /no frontmatter/);
  assert.throws(() => parsePost('x.md', '---\ntitle: bare\n---\n'), /key: "value"/);
});

test('drafts are left out unless asked for, and the feed never lists a draft', () => {
  const posts = [parse(), parse({ title: 'Draft', slug: 'draft', draft: 'true' })];
  const pub = renderBlog(posts, { siteUrl: SITE });
  assert.deepEqual([...pub.files.keys()].sort(), ['a-title/index.html', 'feed.xml', 'index.html']);
  assert.ok(!pub.files.get('index.html').includes('draft'));
  const all = renderBlog(posts, { siteUrl: SITE, includeDrafts: true });
  assert.ok(all.files.has('draft/index.html'));
  assert.ok(!all.files.get('feed.xml').includes('/draft/'), 'a draft must never reach the feed');
});

test('posts are newest first, and a repeated slug is an error', () => {
  const a = parse({ date: '2026-10-01', slug: 'older' });
  const b = parse({ date: '2026-10-20', slug: 'newer' });
  const { posts } = renderBlog([a, b], { siteUrl: SITE });
  assert.deepEqual(posts.map((p) => p.slug), ['newer', 'older']);
  assert.throws(() => renderBlog([b, b], { siteUrl: SITE }), /duplicate slug/);
});

test('generated pages have no script, no inline handler and no third-party URL, and escape text', () => {
  const p = parse({ title: 'Tags <b>& "quotes"', slug: 'tags' }, 'Text with `<code>` inline.\n');
  const { files } = renderBlog([p], { siteUrl: SITE });
  for (const [name, text] of files) {
    if (name.endsWith('.xml')) continue;
    assert.ok(!/<script/i.test(text), `${name}: script`);
    assert.ok(!/\son\w+\s*=/i.test(text), `${name}: handler`);
    assert.match(text, /script-src 'none'/);
    for (const m of text.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) assert.match(m[1], /^https:\/\/(sanctum\.enigma\.sh|github\.com\/Enigma-Technologies-Solutions)/, `${name}: ${m[1]}`);
  }
  const page = files.get('tags/index.html');
  assert.ok(!page.includes('<b>&'), 'title must be escaped');
  assert.match(page, /&lt;b&gt;&amp; &quot;quotes&quot;/);
  assert.match(page, /<code>&lt;code&gt;<\/code>/);
});

test('post pages carry the cover as their social image and the right canonical address', () => {
  const html = renderBlog([parse()], { siteUrl: SITE }).files.get('a-title/index.html');
  assert.ok(html.includes(`<meta property="og:image" content="${SITE}/blog/a-title/cover.png">`));
  assert.ok(html.includes(`<link rel="canonical" href="${SITE}/blog/a-title/">`));
  assert.match(html, /<meta property="og:type" content="article">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
});

test('the index links each post with a sharp thumbnail of known size, and an empty blog says so', () => {
  const html = renderBlog([parse()], { siteUrl: SITE }).files.get('index.html');
  assert.match(html, /href="\.\/a-title\/"/);
  assert.match(html, /src="\.\/a-title\/thumb\.png" width="600" height="400"/);
  assert.match(renderBlog([], { siteUrl: SITE }).files.get('index.html'), /Coming soon/);
});

test('the feed is Atom, escaped, and ordered', () => {
  const xml = feed([parse({ title: 'A & B', slug: 'ab' })], { siteUrl: SITE });
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(xml, /<title>A &amp; B<\/title>/);
  assert.match(xml, /<id>https:\/\/sanctum\.enigma\.sh\/blog\/ab\/<\/id>/);
});

test('the sitemap block is rewritten between its markers, idempotently, and nothing else changes', () => {
  const xml = '<urlset>\n  <url><loc>keep</loc></url>\n  <!-- blog:begin -->\n  <!-- blog:end -->\n</urlset>\n';
  const out = blogSitemap(xml, [parse()], { siteUrl: SITE });
  assert.match(out, /<loc>https:\/\/sanctum\.enigma\.sh\/blog\/<\/loc>/);
  assert.match(out, /<loc>https:\/\/sanctum\.enigma\.sh\/blog\/a-title\/<\/loc>/);
  assert.ok(out.includes('<url><loc>keep</loc></url>'));
  assert.equal(blogSitemap(out, [parse()], { siteUrl: SITE }), out);
  assert.equal(blogSitemap(out, [], { siteUrl: SITE }), xml.replace('<!-- blog:begin -->\n', '<!-- blog:begin -->\n'));
  assert.throws(() => blogSitemap('<urlset></urlset>', [], { siteUrl: SITE }), /markers/);
});

// ── Committed output ─────────────────────────────────────────────────────────

test('the committed blog pages and sitemap match blog-src (build-blog --check)', async () => {
  const { loadPosts } = await import('../build-blog.mjs');
  const { files, posts } = renderBlog(loadPosts(), { siteUrl: SITE });
  for (const [rel, text] of files) assert.equal(readFileSync(join(web, 'blog', rel), 'utf8'), text, `web/blog/${rel} is stale`);
  for (const p of posts) for (const img of ['cover.png', 'thumb.png']) assert.ok(existsSync(join(web, 'blog', p.slug, img)), `${p.slug}/${img}`);
  assert.equal(readFileSync(join(web, 'sitemap.xml'), 'utf8'), blogSitemap(readFileSync(join(web, 'sitemap.xml'), 'utf8'), posts, { siteUrl: SITE }));
});

// ── Brand images ─────────────────────────────────────────────────────────────

test('brand images exist at the sizes the pages promise', () => {
  const want = {
    'assets/og.png': [1200, 630],
    'assets/favicon-32.png': [32, 32],
    'assets/favicon-48.png': [48, 48],
    'assets/apple-touch-icon.png': [180, 180],
    'assets/icon-192.png': [192, 192],
    'assets/icon-512.png': [512, 512],
  };
  for (const [f, [w, h]] of Object.entries(want)) assert.deepEqual(png(join(web, f)), { w, h }, f);
  assert.ok(existsSync(join(web, 'favicon.ico')));
  assert.deepEqual(png(join(repo, 'src-tauri/icons/icon.png')), { w: 512, h: 512 });
  assert.deepEqual(png(join(repo, 'src-tauri/icons/128x128@2x.png')), { w: 256, h: 256 });
  assert.deepEqual(png(join(repo, 'src-tauri/icons/32x32.png')), { w: 32, h: 32 });
  for (const f of ['icon.icns', 'icon.ico']) assert.ok(existsSync(join(repo, 'src-tauri/icons', f)), f);
});

test('every signed tool has a social image and its page points at it', () => {
  const index = JSON.parse(readFileSync(join(web, 'registry/v1/index.json'), 'utf8'));
  assert.ok(index.apps.length >= 2);
  for (const a of index.apps) {
    assert.deepEqual(png(join(web, 'apps', a.app_id, 'og.png')), { w: 1200, h: 630 }, a.app_id);
    const html = readFileSync(join(web, 'apps', a.app_id, 'index.html'), 'utf8');
    assert.ok(html.includes(`content="${SITE}/apps/${a.app_id}/og.png"`), `${a.app_id}: og:image`);
    assert.match(html, /rel="apple-touch-icon"/);
    assert.match(html, /href="\.\.\/\.\.\/favicon\.ico"/);
  }
});

// ── Home page ────────────────────────────────────────────────────────────────

const home = readFileSync(join(web, 'index.html'), 'utf8');

test('the home page has no script, no dash in copy, and the icons and social tags it promises', () => {
  assert.ok(!/<script/i.test(home));
  assert.ok(!/[–—]/.test(home.replace(/<!--[\s\S]*?-->/g, '')), 'em or en dash in copy');
  assert.match(home, /rel="icon" href="\.\/favicon\.ico"/);
  assert.match(home, /rel="apple-touch-icon" href="\.\/assets\/apple-touch-icon\.png"/);
  assert.match(home, /property="og:image" content="https:\/\/sanctum\.enigma\.sh\/assets\/og\.png"/);
  assert.match(home, /name="twitter:image" content="https:\/\/sanctum\.enigma\.sh\/assets\/og\.png"/);
  assert.match(home, /<a href="\.\/blog\/">Blog<\/a>/);
});

test('every relative link and image on the home page points at a file that exists', () => {
  for (const m of home.matchAll(/(?:href|src)="(\.\/[^"#?]*)"/g)) {
    const target = join(web, m[1]);
    assert.ok(existsSync(target) || existsSync(join(target, 'index.html')), `broken link ${m[1]}`);
  }
});

test('the Signed tools section offers exactly the tools in the registry, with valid install links', () => {
  const index = JSON.parse(readFileSync(join(web, 'registry/v1/index.json'), 'utf8'));
  const links = [...home.matchAll(/href="(sanctum:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links.sort(), index.apps.map((a) => installLink(a.app_id)).sort());
  for (const l of links) assert.match(l, /^sanctum:\/\/install\?app=[a-z0-9]+(\.[a-z0-9-]+)+$/);
  for (const a of index.apps) assert.ok(existsSync(join(web, 'registry/v1/apps', a.app_id, 'overview.png')), `${a.app_id} overview screenshot`);
});

test('the privacy answer still says registries are contacted only on request', () => {
  assert.match(home, /A registry is contacted only when you add it, refresh it or install from it/);
  assert.match(home, /does nothing until you click/);
});

test('every post source has its images, and every committed blog folder has a source', () => {
  const src = existsSync(join(repo, 'blog-src')) ? readdirSync(join(repo, 'blog-src')).filter((f) => f.endsWith('.md')) : [];
  const slugs = src.map((f) => f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''));
  const dirs = existsSync(join(web, 'blog')) ? readdirSync(join(web, 'blog'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  assert.deepEqual(dirs.sort(), slugs.sort());
});
