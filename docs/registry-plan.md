# Registry delivery plan

Goal: a user installs Sanctum from sanctum.enigma.sh, adds the Enigma registry, and gets a set
of Enigma-signed tools. Each tool shows its scope before install. A website "Install" button
opens the local Sanctum. Each tool has a changelog, manual and screenshots that can be queried
online. Later, a paid registry of tested tools, with licences issued by Sigil.

Design background is in [registry.md](registry.md). This file is the order of work.

## Where we are (2026-10-17)

| Phase | State |
|---|---|
| 0 to 7 | Built, tested, merged to `main` (PRs #10 to #22). Registry is live at `sanctum.enigma.sh/registry/v1/` with screenshots (index serial 2). |
| Launch site | Merged (#22): `st` brand, Signed tools section, install buttons, blog generator, social images. The launch post was published on 2026-10-16. |
| 8 updates and revocation | Not started. Not needed for 0.2.0 (see `docs/launch.md`). |
| 9 release | Not started: security review, version bump to 0.2.0, signed release, upgrade test. |

The full launch state, remaining checklist and decisions waiting on the maintainer are in
[launch.md](launch.md).

## Where things live

| Where | What |
|---|---|
| GitHub repo, then Pages | Registry content and the signed index. All public. |
| Cloudflare (`enigmahq.sh`) | Mirror of the same signed files, plus anything dynamic: install redirect, revocation fast path, search, download counts, paid delivery (v2). |

The index is signed, so a mirror cannot alter it. The registry has its own signed `id`, so
moving hosts changes nothing for users.

## Rules for every step

- Tests first. New behaviour gets a failing test, then the code that passes it.
- Each step ends with the full suite: `cargo test --lib`, bundle-crate tests, clippy, fmt,
  `pnpm build`, and the Node tests for the scripts.
- One branch and PR per phase, off `main`. A phase starts only when the previous gate passes.
- A registry signature never grants a capability. Install and install all leave every tool
  unapproved.
- The maintainer signs, commits (YubiKey), merges, deploys Cloudflare and checks real windows
  and operating systems. Keys are never touched by tooling.

## Phase 0: land what exists (done 2026-10-15)

PR #10 merged, all checks green, Pages deploy succeeded. `sanctum.enigma.sh/apps/` returns 200
and both live bundle hashes match their cards.

## Phase 1: spec and schema (2 days)

1. Write the format in `registry.md`: index, per-app JSON, `revocations.json`. Fields: `format`,
   `id`, `mirrors`, `kind` (public or licensed), `serial`, `expires`, per-app `access`,
   per-version `attestations[]`, `revoked`, content hashes.
2. Pin the exact signed bytes (canonical JSON).
3. Add a JSON Schema and test vectors: valid, invalid, tampered.

Delivered as `docs/registry-format.md` and `spec/registry/` (schemas, a zero-dependency
reference verifier, 98 vector files, `node --test`). Only the schema review gate remains.

Tests: each fixture is accepted or rejected as labelled. The same canonical-bytes vectors pass
in Node and Rust.
Gate: the maintainer approves the schema. After this it changes only by version bump.

## Phase 2: registry builder (3 days, no app changes)

Status: built and tested on `feat/registry-builder`. The gate is yours: sign with
`scripts/sign-registry.sh`, then merge and check the live files.


1. Per-app content beside each example: `changelog.md`, `manual.md`, `screenshots/`.
2. Extend `publish-bundles.mjs` to emit the index, per-app JSON and static pages at
   `/apps/<id>/` (zero JS, strict CSP).
3. A verify tool, and a signing script the maintainer runs.

Tests: golden output. Tamper controls (flipped byte, wrong hash, lower serial, expired index)
all fail verification. Pages contain no scripts or external URLs. CI builds and verifies the
index against the compiled-in root.
Gate: maintainer signs and merges, then the live index verifies offline.

## Phase 3: index verification in Rust (3 days)

Status: built and tested on `feat/registry-client`: `sanctum_bundle::registry` verifies the
index, revocations, detail and asset files. 120 vector files, 62 cases, identical verdicts in
Rust and Node, and the published registry verifies in Rust. Nothing in the app calls it yet
(that is Phase 4).


1. Index parsing and signature verification in `sanctum-bundle`.
2. Rollback protection (`serial`), `expires`, hash checks, attestation parsing.

Tests: all Phase 1 vectors, malformed and oversize JSON, replayed old serial, unknown fields
kept under the signature, and the real published index from Phase 2 verifies.
Gate: Rust and Node agree on every vector.

## Phase 4: fetch and store (4 days)

Status: built and tested on `feat/registry-client-app` (`src-tauri/src/registry/`): fetcher,
`registries` table, client rules, four Tauri commands and TypeScript wrappers. No interface yet.


1. HTTPS-only fetcher with size and time limits and a redirect policy.
2. SQLite migration for registries, cached verified index.
3. Commands: add, remove, refresh, list.

Tests (local mock server): redirect to another host, oversize body, slow body, wrong
signature, stale serial, plain HTTP. Migration on an existing database.
Gate: a bad registry cannot poison a good cached one. Nothing installs yet.

## Phase 5: install from registry (4 days)

Status: built and tested on `feat/registry-install`: catalogue with install state, install one,
install many, three Tauri commands and TypeScript wrappers. Still no interface (Phase 6).


1. Download, check the index hash, run the existing bundle verification and ingest.
2. Updates go through the existing update path with the same downgrade protection.

Tests: end to end with the mock registry, hash mismatch rejected, same version with different
contents rejected, no duplicate on second install, and install / install all grant zero
capabilities.
Gate: the existing suite plus the new tests pass.

## Phase 6: catalog UI (5 days)

Status: built and tested on `feat/registry-ui`: the Catalogue tab, add-registry and pin flow,
cards with scope, detail pages (changelog, manual, hash-checked screenshots), install and
install all, refresh and remove, plus `registry_app_detail`. Automated: 98 UI tests (Vitest,
Testing Library, axe). The real-window, VoiceOver and Safari checks are in
[registry-ui-checklist.md](registry-ui-checklist.md) and are yours.


1. Add a registry by URL, plus one-click "Add Enigma registry" on the empty first-run screen.
2. Browse with scope, changelog, manual, hash-checked screenshots (Markdown as safe text).
3. Per-app Install and Install all.

Tests: component tests, error states (offline, bad signature, revoked), accessibility
checklist.
Maintainer check: real desktop window, VoiceOver, Safari.

## Phase 7: deep link and install redirect (5 days)

**Status:** built (see `docs/deep-link.md`). Needs the maintainer click-through and the worker deploy.

1. Tauri deep-link plugin, single-instance handling, URL scheme registration per OS.
2. `sanctum://install?registry=...&app=...` always opens a confirmation. Never silent.
3. Cloudflare worker at `enigmahq.sh/install/<app>` that redirects to the scheme, with a
   download fallback.

Tests: parser unit tests with hostile input (unknown registry, huge values, encoding tricks,
other schemes). The dialog always appears.
Maintainer check: click-through on macOS, Windows, Linux from a browser, email and Markdown.

## Phase 8: updates and revocation (3 days)

1. Refresh, "update available", fast `revocations.json` feed.
2. Revoked policy: block first-party, warn third-party.

Built (unreleased, ships with 0.3.0): `registry/notices.rs`, the `check_registries` and
`registry_notices` commands, a gate in `open_tool_window`, a banner in the app and a Registries
section in Settings. The timer is a per-window preference, off by default, checking at most once a
day. A "fast feed" needed no new file: `revocations.json` already has a 30-day lifetime and is
renewed on its own schedule, and the check fetches it with the index.

Tests: revoke after install, stale or tampered feed, offline refresh (all in `registry/install.rs`).

## Phase 9: release (2 days)

1. Security review of the new surface: fetcher, deep link, Markdown rendering.
2. Docs, changelog, version bump, ship through the updater.

## Later: paid registry and Sigil (v2)

Read Sigil first. Then: licence tokens verified offline against a compiled-in licence anchor,
R2-gated bundles behind a Cloudflare worker, a separate review key, and the "Reviewed"
attestation UI. A licence unlocks download and use only. It never grants capabilities. Phases 1
and 3 already carry the fields, so there is no format break.

## Open decisions

- Revoked apps: block or warn (default proposed above).
- Screenshots: fetched live with hash checks (proposed) or bundled.
- Third-party registries at launch: add-by-URL with a warning on unknown publishers (proposed).
- Review key: separate from the publisher key and the root, held by the maintainer.
