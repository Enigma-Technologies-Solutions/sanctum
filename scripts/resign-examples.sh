#!/usr/bin/env bash
# Rebuild the example tools and sign each one at its own version. Press Enter at every prompt.
#
#   scripts/resign-examples.sh otp-vault=1.0.3 shamir=1.0.3 pdf-watermark=1.0.1 hash-check=1.0.1
#
# Steps: regenerate the monogram icons, rebuild every tool's index.html from its sources and
# the shared kit (examples/_kit), then sign each named tool with scripts/sign-example.sh.
# Bundles land next to each tool, e.g. examples/shamir/sh.enigma.shamir-1.0.3.sanctum.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
if [ $# -eq 0 ]; then
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 1
fi
for pair in "$@"; do
  if [[ ! "$pair" =~ ^(otp-vault|shamir|pdf-watermark|hash-check)=[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Not tool=version: $pair" >&2; exit 1
  fi
done
cd "$repo"
node scripts/gen-example-icon.mjs
for t in otp-vault shamir pdf-watermark hash-check; do node "examples/$t/build.mjs"; done
for pair in "$@"; do
  scripts/sign-example.sh -t "${pair%%=*}" -v "${pair#*=}" --no-start
done
printf '\nSigned:\n'
for pair in "$@"; do ls -1 "examples/${pair%%=*}/"*"-${pair#*=}.sanctum"; done
