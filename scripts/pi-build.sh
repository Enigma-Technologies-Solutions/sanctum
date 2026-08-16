#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Enigma Technologies Solutions
#
# Build Sanctum on a Raspberry Pi and produce an installable .deb.
#
#   ./scripts/pi-build.sh            # release build, ~25 min on a Pi 400
#   ./scripts/pi-build.sh --fast     # unoptimised, ~8 min, for iterating
#
# Run ./scripts/pi-setup.sh first.

set -euo pipefail

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

command -v cargo >/dev/null || die "cargo not found — run ./scripts/pi-setup.sh"
command -v pnpm  >/dev/null || die "pnpm not found — run ./scripts/pi-setup.sh"
pkg-config --exists libpcsclite || die "libpcsclite-dev missing — run ./scripts/pi-setup.sh"

# The release profile in Cargo.toml is tuned for distribution builds on CI
# hardware: fat LTO, one codegen unit, opt-level "s". On four Cortex-A72 cores
# that is a very long time in exchange for a slightly smaller binary nobody is
# downloading. Override through the environment so Cargo.toml stays honest
# about what shipped builds use.
export CARGO_PROFILE_RELEASE_LTO=false
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=4
export CARGO_PROFILE_RELEASE_OPT_LEVEL=2
export CARGO_PROFILE_RELEASE_DEBUG=false
# Keep the linker's peak memory down — the usual cause of a Pi build dying at
# 99%. One job is slower but survives 4 GB.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"

say "Installing JS dependencies"
pnpm install --frozen-lockfile

if [ "$FAST" = "1" ]; then
  say "Fast build (debug, no bundle) — binary only"
  pnpm tauri build --debug --no-bundle
  BIN="src-tauri/target/debug/sanctum"
  [ -x "$BIN" ] || die "expected binary at $BIN"
  say "Built $BIN"
  echo "  run it with:  ./$BIN"
  exit 0
fi

say "Release build + .deb (this is the long one)"
pnpm tauri build --bundles deb

DEB=$(find src-tauri/target/release/bundle/deb -name '*.deb' -print -quit 2>/dev/null || true)
[ -n "$DEB" ] || die "no .deb produced — check the output above"

say "Built $DEB"
cat <<EOF

Install it:

  sudo apt install ./$DEB

Then run Sanctum from the desktop menu, or:

  sanctum

The package depends on pcscd, libpcsclite1 and libccid, so apt pulls the smart
card stack in if it is not already there. Check the daemon sees your reader:

  pcsc_scan -r

EOF
