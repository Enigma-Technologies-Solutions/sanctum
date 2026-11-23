#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Enigma Technologies Solutions
#
# The live tests: the real, pinned Codex under Sanctum's sandbox, signed in to a real ChatGPT
# account. macOS only. They use a few turns of that account's plan, so CI never runs them.
#
#   scripts/test-live.sh --sign-in   once: sign a test-only Codex folder in to ChatGPT
#   scripts/test-live.sh             run live_layer_2, live_account and live_create
#
# The sign-in lives in ~/.sanctum-test/codex-home (SANCTUM_TEST_HOME to move it), apart from
# the one Sanctum and Codex use day to day. The tests copy it, and write the renewed copy back,
# because ChatGPT retires an old sign-in when Codex renews it.
#
# The Codex program is the one Sanctum downloaded for the pinned version, checked against the
# pin here. Turn on Build apps with Codex in Sanctum once to download it, or point
# SANCTUM_TEST_CODEX at a copy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PINS="$ROOT/src-tauri/src/agent/codex-pins.json"
TEST_HOME="${SANCTUM_TEST_HOME:-$HOME/.sanctum-test/codex-home}"

[ "$(uname -s)" = Darwin ] || { echo "The live tests run on macOS only." >&2; exit 1; }

case "$(uname -m)" in
  arm64) TARGET=macos-aarch64 ;;
  x86_64) TARGET=macos-x86_64 ;;
  *) echo "Unknown machine $(uname -m)" >&2; exit 1 ;;
esac
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PINS")"
WANT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pins"][sys.argv[2]]["sha256"])' "$PINS" "$TARGET")"
CODEX="${SANCTUM_TEST_CODEX:-$HOME/Library/Application Support/sh.enigma.sanctum/agent/bin/$VERSION/codex}"

if [ ! -x "$CODEX" ]; then
  echo "No Codex $VERSION at $CODEX." >&2
  echo "Turn on Build apps with Codex in Sanctum once to download it, or set SANCTUM_TEST_CODEX." >&2
  exit 1
fi
GOT="$(shasum -a 256 "$CODEX" | cut -d' ' -f1)"
if [ "$GOT" != "$WANT" ]; then
  echo "$CODEX is not the pinned Codex $VERSION (sha256 $GOT, want $WANT)." >&2
  exit 1
fi

if [ "${1:-}" = "--sign-in" ]; then
  mkdir -p "$TEST_HOME"
  chmod 700 "$TEST_HOME"
  echo "Signing a test-only Codex folder in to ChatGPT: $TEST_HOME"
  CODEX_HOME="$TEST_HOME" "$CODEX" login
  exit 0
fi

AUTH="$TEST_HOME/auth.json"
if [ ! -f "$AUTH" ]; then
  echo "No test sign-in at $AUTH. Run: scripts/test-live.sh --sign-in" >&2
  exit 1
fi

cd "$ROOT/src-tauri"
SANCTUM_TEST_CODEX="$CODEX" SANCTUM_TEST_AUTH="$AUTH" \
  cargo test --lib live_ -- --ignored --test-threads=1 --nocapture
