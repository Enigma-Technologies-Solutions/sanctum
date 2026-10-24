<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Enigma Technologies Solutions
-->

# Sanctum 0.2.0: launched

**Completed 2026-10-19.** Sanctum 0.2.0 is published, the signed registry is live, the website and
launch post are public, and the updater has been proven from a real v0.1.0 install. This file is
the record of what shipped, what is untested, what needs attention on a date, and how to do the
next kinds of work. The registry design is in [registry-plan.md](registry-plan.md).

## Needs attention on a date

| Due | What | How |
|---|---|---|
| **2026-11-02** (renewed on 2026-10-19; renew again by 2026-10-30) | `revocations.json` expires 14 days after it is issued, so it needs renewing at least every two weeks. The weekly CI job only fails after a lapse and runs Mondays 06:17 UTC, so do not wait for it. | `scripts/sign-registry.sh --renew` (interactive, YubiKey, the maintainer runs it), then PR and merge. Pages deploys on merge. |
| **2027-01-17** (renewed on 2026-10-19) | `index.json` expires 90 days after it is issued. | Same command, which renews both. |
| Each Tauri or updater plugin update | Recheck `cargo audit`. Six advisories are accepted with reasons in `docs/security-review-0.2.0.md`. | `cd src-tauri && cargo audit`; `pnpm audit --prod`. |

## What shipped

- **Release:** tag `v0.2.0`, published 2026-10-19 from `release.yml` after a green dry run.
  macOS is signed and notarized. `latest.json` lists 15 platforms and every signature matches its
  `.sig` file. A real v0.1.0 install updated to 0.2.0 and kept its tool, approvals and data.
- **Registry:** format v1 with signed vectors, builder, Rust and Node verifiers, fetcher, store,
  install flow, Catalogue UI, and `sanctum://install` links with a mandatory confirmation
  ([deep-link.md](deep-link.md)). Live at `https://sanctum.enigma.sh/registry/v1/`, index serial 2,
  signed with the registry key (certified by the Enigma root for `registry:sh.enigma.`). Tools:
  OTP Vault 1.0.2 and Shamir 1.0.2, four screenshots each.
- **App:** Catalogue tab, shared page header on every tab, Tool Vault grouped by publisher with a
  "Your tools" section, first-run welcome panel ("Browse signed tools"), theme setting (System,
  Light, Dark), `st` monogram in the header and the desktop icons.
- **Security (Phase 9):** a self-review of the new surface and two low findings fixed (the link
  dialog delay and hidden-character stripping), `rustls` updated, build-time packages moved to dev
  dependencies. Details: [security-review-0.2.0.md](security-review-0.2.0.md).
- **Website:** white by default (dark kept under `data-theme`), Signed tools section, Install in
  Sanctum buttons, per-tool pages, social images, blog and Atom feed, and the launch post
  "Personal software, on your terms" at `/blog/introducing-sanctum/` (dated 2026-10-16 by
  decision).
- **Install worker:** `https://enigmahq.sh/install/<app_id>` (static page, strict CSP, no script).
  Needed a proxied DNS record on `enigmahq.sh` before it answered. `/install/<invalid>` is a 404.
- **CI:** UI tests, Rust tests and clippy, Node builder and worker tests, the published registry
  check, `build-blog --check`, a dash scan on public copy, and a weekly signature-expiry job.

### PRs

#10 to #20 signed bundles and the registry (format, builder, verifier, client, install, Catalogue, theme, screenshots,
header, links), #21 first run, #22 site and brand, #23 launch post, #24 launch docs, #25 light
theme, #26 security fixes, #27 version 0.2.0, #28 dependency audit, #29 release-day edits.

## Decisions made

- **Phase 8 skipped for 0.2.0.** Registries are contacted only on a click, which keeps the privacy
  copy true. Cost: a withdrawn tool is noticed only on a manual refresh. Phase 8 (refresh timer,
  update-available notices, fast revocation feed, block first-party and warn third-party) must
  change the privacy copy first.
- **`st` monogram is the brand mark.** The white site is the default.
- **Post date stays 2026-10-16**, although the release is dated 2026-10-19.
- **Blog style (maintainer's feedback):** formal and professional, no run of three-word
  sentences, lists as real bullets, no sentence with two colons, link tools to their pages, one
  introduction before the product. See "Articles" below.

## Not verified yet

Passed on macOS on 2026-10-19 (`Sanctum 0.2.0 checklist`, generated from `docs/registry-ui-checklist.md`
plus the install and update steps): first run, theme, Catalogue, install links, offline and
network behaviour, keyboard, website, the worker, and the updater.

Not run on a real machine:

- [ ] Windows and Linux: `sanctum://` link delivery and single-instance behaviour on a second click.
- [ ] Linux AppImage scheme registration.
- [ ] The Linux updater (the `latest.json` has deb and rpm entries that nobody has tried).
- [ ] VoiceOver.

Say so in the release notes if asked; the post makes no platform-specific claim.

## Next work

### Articles about Sanctum and what to use it for

- Source: `blog-src/YYYY-MM-DD-slug.md` with front matter `title`, `date`, `slug`, `excerpt`,
  `kicker`, `cover_title`, `cover_sub`. Add `draft: "true"` to keep a post out of `web/`.
- Build: `node scripts/build-blog.mjs` (writes `web/blog/`, index, feed and sitemap entries);
  `--check` is what CI runs; `--preview DIR` renders drafts outside `web/`.
- Cover and thumbnail: `node scripts/gen-brand.mjs blog` (headless Chrome and ImageMagick).
- Rules: no em or en dashes, no AI voice, no emoji, Lucide icons only, English. CI scans
  `web/blog` and `blog-src`. Follow the style decisions above.
- Ideas that fit what exists: generating keys with a tool you can inspect and still run in five
  years; splitting a secret with Shamir and what the share format checks; keeping one-time codes
  in OTP Vault and on a YubiKey; reading an approval screen (what Storage, Network host and
  Smart card each allow); why a signature never grants access; running a model-written tool
  safely; what to check in a network monitor.

### A LinkedIn article

- Nothing to build. Reuse the story that worked in the post: the company that needed keys it
  could trust for five years, then the three conditions. Link to a tool page
  (`https://sanctum.enigma.sh/apps/sh.enigma.shamir/`) or the post, and use their social cards
  (`web/blog/<slug>/cover.png`, `web/apps/<app_id>/og.png`). Same voice rules, including no dashes.

### New tools for the Enigma registry

1. **Write the tool** as one HTML file under `examples/<name>/` (Shamir has a `build.mjs` that
   inlines sources; OTP Vault is a plain page). Keep what it asks Sanctum for declared and honest:
   the scanner's findings must match the capabilities the signed statement declares, or the
   install is refused. Tests live in `examples/<name>/test` and run with
   `node --test examples/<name>/test/*.test.mjs`.
2. **Icon:** add the tool to the table in `scripts/gen-example-icon.mjs`, then run it.
3. **Sign a bundle:** `scripts/sign-example.sh -t <name> -v <semver>` (guided; the maintainer's
   keys; never touch the key files). `scripts/resign-examples.sh <semver>` does both existing
   tools. A version may only go up: downgrades are refused. `app_id` is `sh.enigma.<name>`.
4. **Registry entry:** `registry/apps/<app_id>/` with `app.json` (summary, description, license,
   source URL, screenshot files and alt text), `CHANGELOG.md`, `manual.md` (a strict Markdown
   subset: headings, bold, italic, code, one-level lists, quotes, https links; no HTML or images),
   and three or four screenshots of the same size (1600x1131 PNG so far).
5. **Build and sign the registry:** `node scripts/build-registry.mjs --bundles examples`, then
   `scripts/sign-registry.sh --bundles examples` (interactive, the maintainer's step), then
   `node scripts/verify-registry.mjs`. The builder also writes the per-tool pages, and keeps
   `web/apps/<app_id>/og.png`; make a new one with `node scripts/gen-brand.mjs apps`.
6. **Home page card:** add the tool to the "Signed tools" grid in `web/index.html`. A launch test
   requires that grid to list exactly the tools in the registry, so CI fails without it.
7. **PR and merge.** The registry and pages deploy with Pages on merge; the registry check in CI
   fails if the committed files are out of date.

Rules that never change: a signature identifies the publisher and unchanged bytes, never "safe";
it never grants a capability; an install starts with no approvals ([registry-format.md](registry-format.md)).

## How work was run (so it can be repeated)

- Small branches, one PR each, merge commits (never squash). Retarget a stacked PR to `main`
  after its base merges, and never delete a base branch before the PR on top of it merges.
- `main` requires a review, so the maintainer merges with `gh pr merge N --merge --admin`.
  Claude cannot merge or script merges. CI takes about 10 minutes; macOS is the slow job.
- Commits need a YubiKey touch, so the maintainer commits and pushes; Claude prepares the tree
  and the exact commands. Never `--no-gpg-sign`. A `Card error` usually means a missed touch:
  retry, or `gpgconf --kill gpg-agent scdaemon` and replug the key.
- A worktree branch made from `origin/main` has `origin/main` as its upstream. Push with
  `git push -u origin HEAD`, never `HEAD:main`.
- Signing, the release workflow (`git tag -s vX.Y.Z && git push origin vX.Y.Z`; a manual
  `gh workflow run release.yml` is a dry run that publishes nothing), and Cloudflare deploys are
  the maintainer's commands. The release is created as a draft: check that `latest.json` and the
  `.sig` files are attached, then `gh release edit vX.Y.Z --draft=false`.
- Re-sign the registry only when `index.json` changes, not for page-only changes.
- Site changes deploy on merge, so anything that mentions a new version waits until the release
  exists.
