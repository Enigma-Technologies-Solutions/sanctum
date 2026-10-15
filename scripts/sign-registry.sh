#!/usr/bin/env bash
# Guided: build the registry, sign what changed, verify the result.
# Every prompt's default is the expected answer: press Enter.
#
#   scripts/sign-registry.sh [--renew] [--bundles DIR]
#
# --renew re-issues both files with a new serial and a fresh expiry even if nothing changed.
# Run it before they lapse (index 90 days, revocations 14 days). --bundles sets where the
# signed .sanctum files are looked for (default: examples/).
#
# The registry is signed by its own key, which is certified by the root for registry ids only
# (scope "registry:sh.enigma."). The root stays offline and is used once, to issue that
# certificate. Nothing is printed from a key file except its public key id. The site deploys
# from main; this script never commits or pushes.
set -euo pipefail

# The root key compiled into Sanctum (src-tauri/src/trust.rs).
EXPECTED_ROOT="ed25519:GmNzEGh_57SWBOBLNV7kEnhykqoCkcCCMAnbkh0IVHY"
REGISTRY_ID="registry:sh.enigma.public"
SCOPE="registry:sh.enigma."

repo=$(cd "$(dirname "$0")/.." && pwd)
cli_manifest="$repo/src-tauri/crates/sanctum-bundle/Cargo.toml"
cli() { cargo run -q --manifest-path "$cli_manifest" -- "$@"; }
out="$repo/web/registry/v1"

renew=0; bundles=""
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --renew)   renew=1; shift ;;
    --bundles) [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 1; }; bundles=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)         echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ ! -t 0 ]; then echo "Run this in a terminal." >&2; exit 1; fi

ask() { local r; read -r -p "$1 [$2] " r || r=""; echo "${r:-$2}"; }
yn()  { local d=${2:-Y} h r; [ "$d" = Y ] && h="Y/n" || h="y/N"
        read -r -p "$1 [$h] " r || r=""; r=${r:-$d}; [[ "$r" =~ ^[Yy] ]]; }
expand() { echo "${1/#\~/$HOME}"; }
json_get() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

printf '\n\033[1mSign the Enigma registry\033[0m\n'

printf '\n\033[1m1. Build\033[0m\n'
build=(node "$repo/scripts/build-registry.mjs")
[ "$renew" = 1 ] && build+=(--renew)
[ -n "$bundles" ] && build+=(--bundles "$bundles")
"${build[@]}"

need_index=0; need_rev=0
[ -f "$out/index.json.sig" ] || need_index=1
[ -f "$out/revocations.json.sig" ] || need_rev=1
if [ "$need_index" = 0 ] && [ "$need_rev" = 0 ]; then
  echo
  echo "Both files are already signed and nothing changed. Use --renew to re-issue them."
  node "$repo/scripts/verify-registry.mjs" || true
  exit 0
fi

printf '\n\033[1m2. Registry key\033[0m\n'
reg_key=$(expand "$(ask "Registry key file" "~/.sanctum-keys/registry.sanctum-key")")
if [ ! -f "$reg_key" ]; then
  echo "  No registry key yet."
  yn "Create one at $reg_key?" Y || exit 1
  cli keygen --out "$reg_key"
  echo "  Back this key up offline, like the others."
fi
reg_id=$(json_get "$reg_key" keyid)
echo "  registry key $reg_id"

printf '\n\033[1m3. Registry certificate\033[0m\n'
cert=$(expand "$(ask "Certificate file" "~/.sanctum-keys/registry.cert.json")")
if [ -f "$cert" ]; then
  # Reuse only if it is for this key, from the expected root, and covers registry ids.
  check=$(python3 - "$cert" "$reg_id" "$EXPECTED_ROOT" "$REGISTRY_ID" <<'EOF'
import base64, json, sys
cert, key, root, registry_id = sys.argv[1:5]
blob = json.load(open(cert))
p = blob["payload"]; p += "=" * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
ok = c["subject"] == key and blob["keyid"] == root and any(s and registry_id.startswith(s) for s in c["scope"])
print("ok" if ok else "no")
EOF
)
  if [ "$check" = ok ]; then
    echo "  Reusing $cert (for this key, from the root, covers registry ids)."
  else
    echo "$cert exists but is not a registry certificate for this key. Move it aside and re-run." >&2; exit 1
  fi
else
  root_key=$(expand "$(ask "Root key file (used once, to certify the registry key)" "~/.sanctum-keys/root.sanctum-key")")
  [ -f "$root_key" ] || { echo "No such file: $root_key" >&2; exit 1; }
  root_id=$(json_get "$root_key" keyid)
  echo "  root $root_id"
  if [ "$root_id" != "$EXPECTED_ROOT" ]; then
    echo "WARNING: this root is not the one compiled into Sanctum ($EXPECTED_ROOT)." >&2
    yn "Continue anyway?" N || exit 1
  fi
  [ "$root_id" != "$reg_id" ] || { echo "The root and registry keys must be different keys." >&2; exit 1; }
  cert_name=$(ask "Name shown to users" "Enigma Technologies Solutions")
  if date -v+2y +%s >/dev/null 2>&1; then default_end=$(date -v+2y +%s); else default_end=$(date -d '+2 years' +%s); fi
  not_after=$(ask "Expiry (unix seconds, default two years)" "$default_end")
  cli cert --issuer "$root_key" --subject "$reg_id" --name "$cert_name" \
    --scope "$SCOPE" --not-after "$not_after" --out "$cert"
  echo "  Wrote $cert"
fi

printf '\n\033[1m4. Sign\033[0m\n'
if [ "$need_index" = 1 ]; then
  cli registry-sign --kind index --key "$reg_key" --cert "$cert" --file "$out/index.json" --out "$out/index.json.sig"
fi
if [ "$need_rev" = 1 ]; then
  cli registry-sign --kind revocations --key "$reg_key" --cert "$cert" --file "$out/revocations.json" --out "$out/revocations.json.sig"
fi

printf '\n\033[1m5. Verify against the compiled-in root\033[0m\n'
node "$repo/scripts/verify-registry.mjs" --id "$REGISTRY_ID"

printf '\n\033[1m6. Review and commit\033[0m\n'
git -C "$repo" status --short registry web
echo
echo "Check the diff, then commit with your YubiKey. The site publishes when this reaches main."
