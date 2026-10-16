<!--
SPDX-License-Identifier: AGPL-3.0-only
Copyright (C) 2026 Enigma Technologies Solutions
-->

# Launch state and what is left

Written 2026-10-17 so work can resume from here. Plan for the registry itself is
[registry-plan.md](registry-plan.md); this file is the launch.

## What is done and on `main`

- **Registry (phases 1 to 7):** signed format and vectors, builder, Rust verifier, fetcher and
  store, install from a registry, Catalogue UI, `sanctum://install` links with a mandatory
  confirmation (`docs/deep-link.md`). Live at `https://sanctum.enigma.sh/registry/v1/`, index
  serial 2, signed with the registry key (certified by the Enigma root for `registry:sh.enigma.`).
  Tools: OTP Vault 1.0.2 and Shamir 1.0.2, each with four screenshots.
- **App:** Catalogue tab, shared page header on every tab, Tool Vault split into "Your tools" and
  one group per publisher, theme toggle (System, Light, Dark) in Settings, first-run welcome
  panel ("Browse signed tools"), `st` monogram in the header and the desktop icons.
- **Website (PR #22):** `st` favicon and social card, a per-tool social image, a Signed tools
  section with Install in Sanctum buttons, FAQ and privacy copy updated, a blog generator
  (`blog-src/` to `web/blog/`) and Atom feed. Brand rasters come from `scripts/gen-brand.mjs`.
- **Install worker:** `workers/install/` (tests pass) for `https://enigmahq.sh/install/<app_id>`.
  **Not deployed.**
- **CI:** `pnpm test` (139+ UI tests), Rust tests and clippy, Node builder and worker tests,
  the published registry check, `build-blog --check`, a dash scan on public copy, and the Linux
  bundler needs `xdg-utils` (added to `ci.yml` and `release.yml`).

## Not on `main` yet

- **PR #23** (`feat/publish-launch-post`, commit `aca1d95`, open): removes `draft: "true"` from
  `blog-src/2026-10-16-introducing-sanctum.md` and regenerates `web/blog/`. **Do not merge it until
  0.2.0 is released.** The post describes the Catalogue, install links and "Browse signed tools",
  which v0.1.0 does not have, and it still lacks the maintainer's own voice (see below). Merging it
  is what makes the post public; set the post date to the release day first (rename the file and
  `date:`, then `node scripts/build-blog.mjs` and `node scripts/gen-brand.mjs blog`).

## Decisions waiting on the maintainer

1. **The launch post needs the maintainer's voice.** Three questions, in a few lines each:
   why Sanctum was built (a real moment or scare), who it is for on day one, and what a
   skeptical reader should believe afterwards. The current draft only uses claims already on the
   site. Also the 0.2.0 release date, so the post date is right.
2. **Ship 0.2.0 without Phase 8?** Recommended: yes. Registries are only contacted on a click,
   which keeps the privacy copy true. The cost is that a withdrawn tool is only noticed on a
   manual refresh. Phase 8 (refresh when opening the Catalogue, "update available", fast
   revocation feed, block first-party and warn third-party) must change the privacy copy first.
3. **Website theme:** `feat/web-light-theme` (local, unmerged) makes the site white by default.
   Not applied. Say if the site should go light for launch.

## Checklist to go live

Code and release
- [ ] Phase 9 security review of the new surface: fetcher, link handling, Markdown rendering,
      and the two new Tauri plugins (`tauri-plugin-deep-link`, `tauri-plugin-single-instance`,
      which pulled about 480 lines of new `Cargo.lock`, mostly Linux-only crates).
- [ ] Bump the version to 0.2.0 in `package.json`, `src-tauri/tauri.conf.json`,
      `src-tauri/Cargo.toml`; write the CHANGELOG section from `[Unreleased]`.
- [ ] Run the signed, notarised release (`release.yml`; credential steps are the maintainer's).
- [ ] Upgrade a real v0.1.0 install to prove the updater end to end (still unproven).
- [ ] Update the home page pill from `v0.1.0` to `v0.2.0`.

Hands-on checks (list in `docs/registry-ui-checklist.md`)
- [ ] Windows and Linux link delivery, and single-instance behaviour on a second click.
- [ ] Dark theme on every screen; VoiceOver; Safari/WebKit rendering.
- [ ] New app icon in the macOS Dock, the Windows taskbar and the Linux launcher.
- [ ] Deploy the worker (`cd workers/install && npx wrangler deploy`), then check
      `https://enigmahq.sh/install/sh.enigma.shamir` and a 404 for an invalid id.
- [ ] Live pages after deploy: home Signed tools section, a tool page's Install button, a
      pasted tool URL in a social card debugger.

Launch day
- [ ] Finish the post, set its date, merge PR #23, check `/blog/` and the feed.
- [ ] Announce. Watch GitHub issues and the updater.

## How work was run (so it can be repeated)

- Branches are small and one PR each. Merge with merge commits, never squash, and retarget
  stacked PRs to `main` first. Do not delete a base branch before the PR on top of it merges.
- `main` requires a review, so the maintainer merges with `gh pr merge N --merge --admin`.
  Claude cannot merge or script merges (blocked by design). CI takes about 10 minutes; the
  macOS build is the slow one.
- Commits need a YubiKey touch, so the maintainer commits; Claude prepares the working tree and
  the exact commands. Never `--no-gpg-sign`.
- `~/Projects/ship-registry-stack.sh` (outside the repo) did commit, push, PR and the
  screenshots signing; it never merges. Worktrees `~/Projects/sanctum-shots` and
  `~/Projects/sanctum-launch` are done and can be removed with `git worktree remove`.
- A worktree branch made from `origin/main` has `origin/main` as its upstream. Push with
  `git push -u origin HEAD`, never `HEAD:main`.
- Re-signing the registry (`scripts/sign-registry.sh`) is only needed when `index.json`
  changes, not for page-only changes. The index is valid 90 days and revocations 14: a weekly CI
  job fails when either lapses; run `sign-registry.sh --renew`.

## Not verified by anyone yet

Real OS delivery of `sanctum://` links (macOS was clicked through and worked; Windows and Linux
were not), the Linux AppImage scheme registration, VoiceOver, colour contrast, Safari rendering,
the worker once deployed, and the updater across a version.
