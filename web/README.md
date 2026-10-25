# Sanctum landing site

Static site with no dependencies and no JavaScript. The home page is hand-written HTML and
CSS with self-hosted fonts and makes no third-party requests. The blog, the guides and the
tool pages are generated from sources elsewhere in the repo by Node scripts and committed;
there is no build step at deploy time.

## Run it locally

```bash
cd web
python3 -m http.server 4000
# → http://localhost:4000
```

Or just open `index.html` in a browser. Every path is relative.

## Layout

```
web/
├── index.html        # the home page (hand-written)
├── styles.css        # ETS brand system, no framework, shared by every page
├── _headers          # CSP + security headers (Cloudflare Pages / Netlify)
├── robots.txt
├── sitemap.xml       # hand-written, except the blog:begin/end and docs blocks
├── blog/             # GENERATED from blog-src/ by scripts/build-blog.mjs; see docs/blog.md
│   ├── index.html    #   post list
│   ├── feed.xml      #   Atom feed
│   └── <slug>/       #   index.html + cover.png + thumb.png per published post
├── docs/             # GENERATED from docs/ by scripts/build-docs.mjs (guides in scripts/lib/docs.mjs)
├── apps/             # GENERATED per-tool pages by scripts/build-registry.mjs
├── registry/         # GENERATED signed registry by scripts/build-registry.mjs
└── assets/
    ├── favicon.svg   # "st" monogram (assets/logo/, scripts/gen-monogram.py)
    ├── favicon-32.png, favicon-48.png, apple-touch-icon.png, icon-192.png, icon-512.png
    │                 # drawn by scripts/gen-brand.mjs; favicon.ico lives beside index.html
    ├── og.png        # 1200×630 social card
    ├── fonts.css     # @font-face declarations
    └── fonts/        # Inter (variable), Poppins, Space Mono; latin subsets, 96 KB total
```

## Icons

Icons come from [Lucide](https://lucide.dev) (ISC), the same set the desktop app uses
through `lucide-react`. Don't mix in another family or use emoji. Paste the icon's SVG
inline with `class="i"` and `aria-hidden="true"`; for list markers, use the `.i-check` /
`.i-x` mask classes in `styles.css`.

## Design

Two themes in the ETS brand (layout ideas borrowed from display.dev's 2026 redesign).
**Light is the default**: a white page, which also matches the desktop app's own light UI,
so the mockups look like the product. The original dark theme is kept, unchanged in look,
under `<html data-theme="dark">`. The page runs no script, so the theme is chosen in
markup, not toggled. Tokens are at the top of `styles.css`.

| Token | Light (default) | Dark | Use |
|---|---|---|---|
| Volt | `#FBFF00` | `#FBFF00` | Fills only: buttons, the band, toggles, eyebrow squares. **Always black ink on volt** |
| Surfaces | `#FFFFFF` → `#F7F7F4` → `#FFFFFF` → `#F2F2EE` | `#0A0A09` → `#10100E` → `#151513` → `#1B1B18` | Page → alternate section → card → inset |
| Ink | `#0A0A09` / `#45453F` / `#6B6B64` | `#F5F5F0` / `#A6A69E` / `#6F6F68` | Headings / body / labels |
| `--accent-fg` | ink | volt | Checks, "allowed" labels, numbers: anything that was volt *text* |
| `--accent-line` | ink | volt | Featured plan border, isolation wall |
| Bad | `#C2331F` | `#FF6B5B` | "Blocked" states in mockups |

- **Volt is never a text colour on white.** `#FBFF00` on `#FFFFFF` has a contrast ratio of
  about 1.07. Foreground accents go through `--accent-fg`; the hero emphasis becomes black
  text on a volt highlighter stroke (`--em-bg`).
- Light ink values keep body text at 9:1 and labels above 5:1 on white.
- The "denied" panel on the volt band stays dark in both themes, by design.

- **Poppins** for display headings, **Inter** for body and UI, **Space Mono** for data, code,
  and eyebrow labels only, never UI chrome.
- The volt square in eyebrows, the wordmark square and the ETS tile are **always sharp**:
  `border-radius: 0`. Cards and buttons are rounded.
- Section headers put the heading left and the lede right (`.shead`).
- Every product visual (approval screen, request logs, APDU log, toggles) is HTML and CSS.
  There are no screenshots to go stale; edit the markup when the product changes.
- The FAQ uses `<details>`, so it opens and closes with no JavaScript.
- **No inline styles.** `style-src 'self'` in the CSP rejects `style=""` attributes, so
  every rule belongs in `styles.css`.
- Mockup content must stay true to the product: hostnames are illustrative, but every
  state shown (blocked by CSP, per-host approval, refused `SELECT`) is real behaviour.

## Go-live status

- [x] **Domain:** `sanctum.enigma.sh`, set in `index.html` (canonical, `og:url`,
      `og:image`), `robots.txt` and `sitemap.xml`.
- [x] **Real download:** hero and pricing CTAs point at
      `github.com/Enigma-Technologies-Solutions/sanctum/releases/latest`, which always
      resolves to the newest published release. Linking the page rather than a file keeps
      it version-proof: installer filenames carry the version number.
- [x] **Status line:** says v0.2.0 and what is signed. Update it when Windows signing
      lands or the version moves.
- [ ] Confirm the `in development` tags on the Organization plan still match reality:
      `policy.rs` and `registry.rs` are stubs today, and the site says so on purpose.
- [ ] Point `ultra@enigma.sh` at whoever handles design-partner intake.

## Deploy: GitHub Pages

`.github/workflows/pages.yml` publishes this directory on every push to `main` that
touches `web/**`. No build step: the directory is uploaded as committed.

One-time setup (already done for this repo):

1. Settings → Pages → Source: **GitHub Actions**.
2. Custom domain: `sanctum.enigma.sh`. With an Actions deploy the domain lives in repo
   settings. A `CNAME` file in this directory would be ignored, so there isn't one.
3. DNS at the registrar: `CNAME  sanctum  →  enigma-technologies-solutions.github.io.`
4. Once the certificate is issued, tick **Enforce HTTPS**.
5. Verify `enigma.sh` under the **organization's** Settings → Pages → Verified domains, so
   no other GitHub account can claim a subdomain of it if this site is ever unpublished.

## Security headers on GitHub Pages

GitHub Pages cannot send custom response headers, so `_headers` is **not applied** there.
The part that matters most is delivered as a `<meta http-equiv="Content-Security-Policy">`
in `index.html` instead: `script-src 'none'`, `connect-src 'none'`, `form-action 'none'`,
`base-uri 'none'`, self-only styles, fonts and images.

`upgrade-insecure-requests` is deliberately **left out of the meta tag** even though
`_headers` has it. Safari applies it to `http://127.0.0.1`, rewriting the stylesheet and
font requests to `https://` and breaking local preview (Chrome exempts loopback, so it is
easy to miss). Every subresource here is a relative URL, so on the HTTPS site it would
upgrade nothing anyway.

What a meta tag cannot carry, and is therefore lost on Pages:

| Lost | Consequence here |
|---|---|
| `frame-ancestors` / `X-Frame-Options` | The page can be framed. It has no forms, logins or state-changing buttons, so clickjacking has nothing to click. |
| `Strict-Transport-Security` | Pages still redirects HTTP → HTTPS once *Enforce HTTPS* is on; only the preload-grade guarantee is missing. |
| `Permissions-Policy`, `COOP`, `CORP`, `nosniff` | Defence in depth for a page that runs no script. |

`_headers` stays in the directory so the full policy comes back unchanged if the site ever
moves to Cloudflare Pages or Netlify (build command empty, output directory `web`), or
if Cloudflare is put in front of Pages.

The CSP is deliberately strict. If you ever add analytics or a script tag, **both** the
meta tag and `_headers` have to be relaxed. Treat that as a decision, not a formality.


## Writing a blog post

The full guide is [`docs/blog.md`](../docs/blog.md): prerequisites, every frontmatter field,
generating the cover and thumbnail, building, previewing drafts locally and publishing. In
short: write `blog-src/YYYY-MM-DD-slug.md`, run `node scripts/gen-brand.mjs blog` and
`node scripts/build-blog.mjs`, commit `blog-src/` together with `web/blog/` and
`web/sitemap.xml`, and merge to `main`.

## Brand images and the blog

- `node scripts/gen-brand.mjs [icons|site|apps|blog]` draws every raster with headless Chrome:
  the desktop `icon.png`, the favicons, the home page social card, one card per signed tool
  (`apps/<id>/og.png`, which the registry builder leaves alone) and each blog post's cover and
  thumbnail. Change the generator or `assets/logo/`, never the PNGs.
- Posts are `blog-src/<date>-<slug>.md`. `node scripts/build-blog.mjs` writes `web/blog/` and the
  sitemap block, `--check` is what CI runs, and `--preview DIR` also renders drafts
  (`draft: "true"`), which are never written to `web/`. `gen-brand.mjs blog` skips drafts too;
  `gen-brand.mjs blog --preview DIR` draws their images for a preview. Remove the `draft` line to publish, then
  run `gen-brand.mjs blog` if the title changed.
- Posts use the same strict Markdown subset as registry manuals: no raw HTML, no images, no
  em or en dashes.
