# Contributing to Sanctum

## Before you start

- For bug fixes and small improvements, open an issue first.
- For new features, open a discussion before writing code. We keep the scope of the app small on purpose.
- Security issues: see [SECURITY.md](SECURITY.md). Do not open a public issue.

## Development setup

```bash
# Prerequisites: Rust ≥ 1.77, Node.js ≥ 20, pnpm

git clone https://github.com/Enigma-Technologies-Solutions/sanctum
cd sanctum
pnpm install
pnpm tauri dev
```

## Workflow

1. Fork the repo and create a branch from `main`.
2. Make your changes. Keep each commit to one logical change.
3. Run checks locally before pushing:
   ```bash
   cargo clippy --all-targets -- -D warnings
   cargo test
   pnpm build
   ```
4. Open a PR against `main` and describe what it changes and why.
5. A maintainer will review within a few business days.

## Writing a blog post

Posts live in `blog-src/` and are built into `web/blog/` by two Node scripts. The whole
workflow (prerequisites, frontmatter fields, cover images, drafts, local preview, publishing)
is in [docs/blog.md](docs/blog.md). The site itself is described in [web/README.md](web/README.md).

## Code style

- Rust: `cargo fmt` before committing. Clippy warnings are errors in CI.
- TypeScript: there's no linter config yet, so match the surrounding code.
- No new `console.log` in production paths.
- Default to writing no comments. Only add one when the *why* is non-obvious.

## Licensing

By submitting a pull request you agree that your contribution is licensed under
AGPL-3.0-only and that Enigma Technologies Solutions may re-license it under a
commercial license as part of the dual-license model described in the README.

All source files must include the SPDX header:
```
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
```
