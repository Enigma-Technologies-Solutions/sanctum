#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
//   node scripts/build-blog.mjs            write web/blog/ and the sitemap block
//   node scripts/build-blog.mjs --check    fail if what is committed differs from the sources
//   node scripts/build-blog.mjs --preview DIR   write everything, drafts included, to DIR
//
// Sources: blog-src/<date>-<slug>.md. Images (cover.png, thumb.png per post) come from
// scripts/gen-brand.mjs; a post whose images are missing is an error, never a broken page.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostError, blogSitemap, parsePost, renderBlog } from './lib/blog.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://sanctum.enigma.sh';

export function loadPosts(dir = join(repo, 'blog-src')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parsePost(f, readFileSync(join(dir, f), 'utf8')));
}

function main(argv) {
  const check = argv.includes('--check');
  const pi = argv.indexOf('--preview');
  const preview = pi >= 0 ? resolve(argv[pi + 1] ?? '') : null;
  if (pi >= 0 && !argv[pi + 1]) throw new PostError('--preview needs a directory');
  const all = loadPosts();
  const { files, posts } = renderBlog(all, { siteUrl: SITE, includeDrafts: !!preview });

  const outDir = preview ?? join(repo, 'web/blog');
  if (!preview) {
    for (const p of posts) {
      for (const img of ['cover.png', 'thumb.png']) {
        if (!existsSync(join(outDir, p.slug, img))) throw new PostError(`${p.slug}: missing ${img}. Run: node scripts/gen-brand.mjs blog`);
      }
    }
  }
  const sitemapPath = join(repo, 'web/sitemap.xml');
  const sitemap = blogSitemap(readFileSync(sitemapPath, 'utf8'), posts.filter((p) => !p.draft), { siteUrl: SITE });

  if (check) {
    const stale = [];
    for (const [rel, text] of files) {
      const f = join(outDir, rel);
      if (!existsSync(f) || readFileSync(f, 'utf8') !== text) stale.push(`blog/${rel}`);
    }
    if (readFileSync(sitemapPath, 'utf8') !== sitemap) stale.push('sitemap.xml');
    if (stale.length) {
      console.error(`The committed blog is out of date:\n${stale.map((s) => `  ${s}`).join('\n')}\nRun: node scripts/build-blog.mjs`);
      process.exit(1);
    }
    console.log(`Blog up to date (${posts.length} post${posts.length === 1 ? '' : 's'}).`);
    return;
  }
  for (const [rel, text] of files) {
    const f = join(outDir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  if (!preview) writeFileSync(sitemapPath, sitemap);
  console.log(`${preview ? 'Preview' : 'Blog'}: ${posts.length} post${posts.length === 1 ? '' : 's'}, ${files.size} files${preview ? ` in ${outDir}` : ''}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (e instanceof PostError) {
      console.error(`error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
