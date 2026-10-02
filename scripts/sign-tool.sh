#!/usr/bin/env bash
# Build a signed .sanctum bundle from a single-file HTML tool.
#
#   scripts/sign-tool.sh TOOL.html APP_ID "Name" VERSION KEYFILE [CERTFILE]
#
# The declared capabilities come from Sanctum's own scanner, so the bundle declares exactly
# what the app will detect at install. KEYFILE is a publisher key made with
# `sanctum-bundle keygen`; CERTFILE is that key's certificate from the root (`sanctum-bundle
# cert`). This script reads the key but never creates or prints one.
set -euo pipefail

if [ "$#" -lt 5 ]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
html=$1; app_id=$2; name=$3; version=$4; key=$5; cert=${6:-}

root=$(cd "$(dirname "$0")/.." && pwd)
cli="$root/src-tauri/crates/sanctum-bundle/Cargo.toml"
out="$(dirname "$html")/${app_id}-${version}.sanctum"
declared=$(mktemp)
trap 'rm -f "$declared"' EXIT

cargo run -q --manifest-path "$root/src-tauri/Cargo.toml" --example scan_declared -- "$html" > "$declared"
echo "declared: $(cat "$declared")" >&2

args=(sign --key "$key" --html "$html" --app-id "$app_id" --name "$name" --version "$version"
      --declared "$declared" --out "$out")
[ -n "$cert" ] && args+=(--cert "$cert")
cargo run -q --manifest-path "$cli" -- "${args[@]}"

echo "wrote $out" >&2
cargo run -q --manifest-path "$cli" -- verify "$out" >&2
