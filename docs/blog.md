# Writing a blog post

How a post on `https://sanctum.enigma.sh/blog/` goes from a Markdown file to the live site.
Everything runs from the repo root. The blog is static HTML with no JavaScript, built by two
scripts and deployed by GitHub Pages.

```
blog-src/2026-10-16-introducing-sanctum.md     you write this
        │
        ├── node scripts/gen-brand.mjs blog     → web/blog/<slug>/cover.png, thumb.png
        └── node scripts/build-blog.mjs         → web/blog/<slug>/index.html, web/blog/index.html,
                                                  web/blog/feed.xml, blog block in web/sitemap.xml
```

Never hand-edit anything under `web/blog/`. Change the source and rebuild.

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node.js 20 or later | Runs both scripts. No `npm install` needed: they use only Node built-ins. | `node --version` |
| Google Chrome | `gen-brand.mjs` draws the cover and thumbnail with headless Chrome. It looks in `/Applications/Google Chrome.app`; set `CHROME=/path/to/chrome` anywhere else. | `ls "/Applications/Google Chrome.app"` |
| ImageMagick | Used by `gen-brand.mjs` (for the favicon `.ico`; the blog target itself only needs Chrome). | `magick --version` |
| Python 3 | Local preview server. Any static server works. | `python3 --version` |

## 2. Create the post file

Create `blog-src/YYYY-MM-DD-slug.md`. The file name must be exactly the `date` and `slug`
from the frontmatter joined by a hyphen, or the build fails.

```markdown
---
title: "Splitting a secret with Shamir"
date: "2026-11-02"
slug: "splitting-a-secret"
excerpt: "What a share is, what the share format checks, and how many you need to get the secret back."
kicker: "Guide"
cover_title: "Splitting a secret"
cover_sub: "Three shares, any two of them."
draft: "true"
---

First paragraph.
```

Start every post with `draft: "true"`. It keeps the post out of `web/` until you delete the
line (see step 7).

## 3. Frontmatter fields

One `key: "value"` per line. Every value must be in double quotes; there is no YAML, so no
lists, multi-line values or comments. An unknown key is a build error.

| Field | Required | Format | What it does |
|---|---|---|---|
| `title` | Yes | Plain text, at most 90 characters | `<h1>` of the post, its entry on `/blog/`, the Atom feed and `<title>`. Also the cover text unless `cover_title` is set. |
| `date` | Yes | `YYYY-MM-DD` | Shown on the post and the list, sorts the list (newest first), and sets the feed and sitemap dates. Must match the file name. |
| `slug` | Yes | Lower-case words joined by hyphens (`a-z`, `0-9`, `-`) | The URL, `/blog/<slug>/`. Must match the file name and be unique. |
| `excerpt` | Yes | One or two sentences, at most 220 characters | Summary on `/blog/`, the feed `<summary>`, and the page's meta and social description. |
| `kicker` | No | A word or two | Small label at the top of the cover and thumbnail. Defaults to `Sanctum blog`. |
| `cover_title` | No | Short text | Headline drawn on the cover and thumbnail. Defaults to `title`. Use it when the title is too long for the image. |
| `cover_sub` | No | One short line | Subheading on the cover only (the thumbnail leaves it out). Defaults to empty. |
| `draft` | No | Exactly `"true"`, or absent | Keeps the post, and its images, out of `web/`. Any other value is a build error. |

### What the body may contain

Posts use the same strict Markdown subset as registry manuals (`scripts/lib/markdown.mjs`).
Anything outside it fails the build with the line number.

- Allowed: headings `#` to `####`, paragraphs, `**strong**`, `*emphasis*`, `` `code` ``,
  fenced code blocks, bullet and numbered lists (one level), block quotes, and links.
- Links must be absolute `https://` URLs. Link a tool as
  `[Shamir](https://sanctum.enigma.sh/apps/sh.enigma.shamir/)`, not with a relative path.
- Not allowed: raw HTML, images in the body, nested lists, tables, CRLF line endings.

### No em or en dashes

The frontmatter and body must not contain `–` (en dash) or `—` (em dash). `build-blog.mjs`
rejects them, and CI separately scans `blog-src/` and `web/blog/` and fails the pull request.
Rewrite the sentence rather than swapping in a hyphen. The house style also asks for formal
copy, no emoji, no run of three-word sentences, and no sentence with two colons; see
"Blog style" in [`launch.md`](launch.md).

## 4. Generate the cover and thumbnail

```bash
node scripts/gen-brand.mjs blog
```

Writes `web/blog/<slug>/cover.png` (1200×630, the social card and the image at the top of the
post) and `thumb.png` (600×400 drawn at 2x, the image in the list) for every post that is not
a draft. The images are text on the brand background, made from `kicker`, `cover_title` (or
`title`), `cover_sub` and `date`. There is no photo to supply. Rerun this whenever one of those
fields changes.

## 5. Build the HTML

```bash
node scripts/build-blog.mjs
```

Writes `web/blog/index.html`, `web/blog/<slug>/index.html` for each published post,
`web/blog/feed.xml`, and the block between `<!-- blog:begin -->` and `<!-- blog:end -->` in
`web/sitemap.xml`. It stops with an error if a published post has no `cover.png` or
`thumb.png`, so run step 4 first.

`node scripts/build-blog.mjs --check` is what CI runs: it fails if the committed `web/blog/`
differs from what `blog-src/` would build.

## 6. Preview locally

A published post (no `draft` line), after steps 4 and 5:

```bash
cd web && python3 -m http.server 4000
# → http://localhost:4000/blog/
```

A draft, without touching `web/blog/`. Both scripts take `--preview DIR`, which writes every
post, drafts included, into `DIR`. Put it inside `web/` so the stylesheet and fonts resolve
(`web/.blog-preview/` is git-ignored):

```bash
node scripts/build-blog.mjs --preview web/.blog-preview
node scripts/gen-brand.mjs blog --preview web/.blog-preview
cd web && python3 -m http.server 4000
# → http://localhost:4000/.blog-preview/<slug>/
```

A draft is badged `Blog · draft` above the date. Delete `web/.blog-preview/` when you are done.

## 7. Publish

1. Delete the `draft: "true"` line.
2. `node scripts/gen-brand.mjs blog` (now draws this post's images).
3. `node scripts/build-blog.mjs`.
4. Commit `blog-src/<file>.md` **and** everything it changed: `web/blog/` (the new
   `<slug>/` folder, `index.html`, `feed.xml`) and `web/sitemap.xml`.
5. Open a pull request. CI checks that `web/blog/` matches `blog-src/` and scans for dashes.
6. Merge to `main`. `.github/workflows/pages.yml` deploys `web/` on every push to `main`
   that touches `web/**`; the post is live at `https://sanctum.enigma.sh/blog/<slug>/` a minute
   or two later.

To change a published post, edit the source and repeat steps 2 to 6. To unpublish one, add
`draft: "true"` back, rebuild, and delete its `web/blog/<slug>/` folder.
