#!/usr/bin/env bash
# Guided: certify your publisher key, sign an example tool, verify the result.
# Every prompt's default is the expected answer: press Enter.
#
#   scripts/sign-example.sh [--tool otp-vault|shamir] [--version 1.0.0]
#                           [--name "OTP Vault"] [--app-id sh.enigma.otp-vault] [--no-start]
#
# Flags only set the prompt defaults, so Enter still accepts them. A bare word is taken as
# --tool. --no-start skips the final "start the app" question (handy when chaining runs).
#
# Uses the keys made with `sanctum-bundle keygen`. It reads them through the CLI and never
# prints a secret. Re-running is safe: an existing certificate is reused if it matches.
set -euo pipefail

# The root key compiled into Sanctum (src-tauri/src/trust.rs). A bundle only shows
# "Verified publisher" when its certificate was issued by this key.
EXPECTED_ROOT="ed25519:GmNzEGh_57SWBOBLNV7kEnhykqoCkcCCMAnbkh0IVHY"

repo=$(cd "$(dirname "$0")/.." && pwd)
cli_manifest="$repo/src-tauri/crates/sanctum-bundle/Cargo.toml"
cli() { cargo run -q --manifest-path "$cli_manifest" -- "$@"; }

tool=otp-vault; d_version=1.0.0; o_name=""; o_app=""; start=1
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --tool|-t)    [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 1; }; tool=$2; shift 2 ;;
    --version|-v) [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 1; }; d_version=$2; shift 2 ;;
    --name)       [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 1; }; o_name=$2; shift 2 ;;
    --app-id)     [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 1; }; o_app=$2; shift 2 ;;
    --no-start)   start=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "Unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *)            tool=$1; shift ;;
  esac
done
case "$tool" in
  otp-vault) d_app="sh.enigma.otp-vault"; d_name="OTP Vault" ;;
  shamir)    d_app="sh.enigma.shamir";    d_name="Shamir Secret Sharing" ;;
  *) echo "Unknown tool '$tool'. Use: otp-vault or shamir." >&2; exit 1 ;;
esac
d_app=${o_app:-$d_app}; d_name=${o_name:-$d_name}

if [ ! -t 0 ]; then echo "Run this in a terminal." >&2; exit 1; fi

ask() { local r; read -r -p "$1 [$2] " r || r=""; echo "${r:-$2}"; }
yn()  { local d=${2:-Y} h r; [ "$d" = Y ] && h="Y/n" || h="y/N"
        read -r -p "$1 [$h] " r || r=""; r=${r:-$d}; [[ "$r" =~ ^[Yy] ]]; }
expand() { echo "${1/#\~/$HOME}"; }
json_get() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

printf '\n\033[1mSign the example: %s\033[0m\n' "$tool"

printf '\n\033[1m1. Keys\033[0m\n'
root_key=$(expand "$(ask "Root key file" "~/.sanctum-keys/root.sanctum-key")")
pub_key=$(expand "$(ask "Publisher key file" "~/.sanctum-keys/publisher.sanctum-key")")
for f in "$root_key" "$pub_key"; do [ -f "$f" ] || { echo "No such file: $f" >&2; exit 1; }; done
root_id=$(json_get "$root_key" keyid)
pub_id=$(json_get "$pub_key" keyid)
echo "  root      $root_id"
echo "  publisher $pub_id"
if [ "$root_id" != "$EXPECTED_ROOT" ]; then
  echo
  echo "WARNING: this root is not the one compiled into Sanctum ($EXPECTED_ROOT)." >&2
  echo "A bundle made with it will install as 'unknown publisher'." >&2
  yn "Continue anyway?" N || exit 1
fi
if [ "$root_id" = "$pub_id" ]; then
  echo "The root and publisher keys are the same. They must be different keys." >&2; exit 1
fi

printf '\n\033[1m2. Publisher certificate\033[0m\n'
cert=$(expand "$(ask "Certificate file" "~/.sanctum-keys/publisher.cert.json")")
if [ -f "$cert" ]; then
  subject=$(python3 - "$cert" <<'EOF'
import base64, json, sys
blob = json.load(open(sys.argv[1]))
p = blob["payload"]; p += "=" * (-len(p) % 4)
print(json.loads(base64.urlsafe_b64decode(p))["subject"])
EOF
)
  issuer=$(json_get "$cert" keyid)
  if [ "$subject" = "$pub_id" ] && [ "$issuer" = "$root_id" ]; then
    echo "  Reusing $cert (matches these keys)."
  else
    echo "$cert exists but is for a different key. Move it aside and re-run." >&2; exit 1
  fi
else
  cert_name=$(ask "Publisher name shown to users" "Enigma Technologies Solutions")
  scope=$(ask "App id prefix it may sign" "sh.enigma.")
  if date -v+2y +%s >/dev/null 2>&1; then default_end=$(date -v+2y +%s); else default_end=$(date -d '+2 years' +%s); fi
  echo "  Default expiry is two years from now (unix $default_end)."
  not_after=$(ask "Expiry (unix seconds)" "$default_end")
  cli cert --issuer "$root_key" --subject "$pub_id" --name "$cert_name" \
    --scope "$scope" --not-after "$not_after" --out "$cert"
  echo "  Wrote $cert"
fi

printf '\n\033[1m3. Sign the tool\033[0m\n'
html=$(expand "$(ask "Tool file" "$repo/examples/$tool/index.html")")
[ -f "$html" ] || { echo "No such file: $html" >&2; exit 1; }
app_id=$(ask "App id" "$d_app")
name=$(ask "Name" "$d_name")
version=$(ask "Version" "$d_version")
out="$(dirname "$html")/${app_id}-${version}.sanctum"
if [ -e "$out" ]; then
  echo "$out already exists."
  yn "Replace it?" Y || exit 0
  rm -f "$out"
fi
"$repo/scripts/sign-tool.sh" "$html" "$app_id" "$name" "$version" "$pub_key" "$cert"

printf '\n\033[1m4. Check against the compiled-in root\033[0m\n'
result=$(cli verify "$out" --anchor "$EXPECTED_ROOT=Enigma Technologies Solutions")
echo "$result"
if echo "$result" | grep -q '^trust       anchored'; then
  printf '\nOK. This bundle will show "Verified publisher: Enigma Technologies Solutions".\n'
else
  printf '\nNot anchored to the compiled-in root. Sanctum will show an unknown publisher.\n' >&2
fi
echo "Bundle: $out"

printf '\n\033[1m5. Try it\033[0m\n'
echo "Drop the .sanctum file onto the Library (or use Open). In Inspect, the Signed row"
echo "should read: Verified publisher: Enigma Technologies Solutions."
if [ "$start" = 1 ] && yn "Start the app now?" Y; then cd "$repo" && pnpm tauri dev; fi
