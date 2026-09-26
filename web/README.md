# Sanctum landing site

Single-page marketing site. **Zero build step, zero dependencies, zero JavaScript.**

A product whose pitch is "we removed the attack surface" shouldn't ship a marketing site
with an npm tree and four CDN origins in it. This is hand-written HTML and CSS. Fonts are
self-hosted. Nothing on the page makes a third-party request.

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
├── index.html        # the entire site
├── styles.css        # ETS brand system, no framework
├── _headers          # CSP + security headers (Cloudflare Pages / Netlify)
├── robots.txt
├── sitemap.xml
└── assets/
    ├── favicon.svg   # nested-square isolation glyph
    ├── og.png        # 1200×630 social card
    ├── fonts.css     # @font-face declarations
    └── fonts/        # Inter (variable), Poppins, Space Mono; latin subsets, 96 KB total
```

## Design

One dark theme (layout ideas borrowed from display.dev's 2026 redesign), in the ETS
brand. Tokens are at the top of `styles.css`.

| Token | Value | Use |
|---|---|---|
| Volt | `#FBFF00` | Primary buttons, the band, checks and "allowed" states. **Always black ink on volt** |
| Surfaces | `#0A0A09` → `#10100E` → `#151513` → `#1B1B18` | Page → alternate section → card → inset |
| Ink | `#F5F5F0` / `#A6A69E` / `#6F6F68` | Headings / body / labels |
| Bad | `#FF6B5B` | "Blocked" states in mockups |

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
- [x] **Status line:** says v0.1.0 and what is signed. Update it when Windows signing
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
