#!/usr/bin/env bash
# Rebuild both example tools and sign them at one version. Press Enter at every prompt.
#
#   scripts/resign-examples.sh 1.0.2
#
# Steps: regenerate the monogram icons, rebuild Shamir's index.html, then sign each tool
# with scripts/sign-example.sh. Bundles land next to each tool, e.g.
# examples/shamir/sh.enigma.shamir-1.0.2.sanctum. Update each card with them in Sanctum.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
version=${1:-}
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/resign-examples.sh <version>   e.g. 1.0.2" >&2; exit 1
fi
cd "$repo"
node scripts/gen-example-icon.mjs
node examples/shamir/build.mjs
scripts/sign-example.sh -t otp-vault -v "$version" --no-start
scripts/sign-example.sh -t shamir -v "$version" --no-start
printf '\nSigned both at %s:\n' "$version"
ls -1 examples/*/*-"$version".sanctum
