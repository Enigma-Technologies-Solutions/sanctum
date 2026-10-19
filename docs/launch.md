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
  `blog-src/2026-10-16-introducing-sanctum.md` and regenerates `web/blog/`. 0.2.0 is
  released, so merging it is what makes the post public: do it when announcing. The date stays
  2026-10-16.

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
- [x] Phase 9 security review of the new surface (self-review, PR #26): `docs/security-review-0.2.0.md`.
      Two low findings fixed.
- [x] Dependency audit (2026-10-18): rustls updated, tailwind plugin moved to dev, the rest
      triaged in `docs/security-review-0.2.0.md`. Re-run `cargo audit` on release day.
- [x] Bump the version to 0.2.0 in `package.json`, `src-tauri/tauri.conf.json`,
      `src-tauri/Cargo.toml` and `Cargo.lock`. Security entries added to `[Unreleased]`.
- [x] Release day PR: CHANGELOG `[0.2.0] - 2026-10-19` with compare links, home page pill, version
      lines in `README.md` and `web/README.md`.
- [x] Signed, notarised release published 2026-10-19 (tag `v0.2.0`, dry run green first).
      `latest.json` lists 15 platforms and every signature matches its `.sig` file.
- [x] Updater proven: a real v0.1.0 install updated to 0.2.0 and kept its tool and approvals.

Hands-on checks (list in `docs/registry-ui-checklist.md`)
Passed on macOS (2026-10-19, `Sanctum 0.2.0 checklist.pdf`): first run, theme, catalogue, install
links, offline and privacy, keyboard, website and brand, the worker, the updater.
- [ ] Windows and Linux link delivery, and single-instance behaviour on a second click (untested).
- [ ] Linux AppImage `sanctum://` registration (untested).
- [ ] VoiceOver (untested; can wait for 0.2.1).
- [x] Dark theme, the new icon, the worker (`enigmahq.sh/install/...`), live site pages, social cards.

Launch day
- [x] The post has the maintainer's own motivation, audience and "what you can check" sections. Its
      date stays 2026-10-16 by decision.
- [ ] Merge PR #23 (`gh pr merge 23 --merge --admin`) when ready to announce, then check `/blog/`
      and the feed.
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
