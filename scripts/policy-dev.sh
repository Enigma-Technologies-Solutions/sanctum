#!/usr/bin/env bash
# Guided test of Sanctum's organisation policy (pinned checksums). Run it in a normal
# terminal (it uses sudo). Every prompt's first option is the expected one: press Enter.
#
#   scripts/policy-dev.sh             interactive
#   scripts/policy-dev.sh --yes       accept every default, no prompts
#   scripts/policy-dev.sh --dry-run   print what would run, change nothing
#
# Steps: pin the OTP vault example, start the app and check it, make the policy file
# writable to prove a broken policy blocks everything, then remove the policy.
# Whatever happens, you are asked before you leave (Ctrl-C included) whether to remove the
# policy, and the default is yes, so a test policy is not left on your machine.
set -uo pipefail

assume_yes=0; dry=0
for a in "$@"; do
  case "$a" in
    --yes|-y) assume_yes=1 ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) dir="/Library/Application Support/Sanctum"; group=wheel ;;
  Linux)  dir="/etc/sanctum";                          group=root  ;;
  *) echo "macOS and Linux only. On Windows use %ProgramData%\\Sanctum\\policy.json by hand." >&2; exit 1 ;;
esac
file="$dir/policy.json"
repo=$(cd "$(dirname "$0")/.." && pwd)

if [ "$assume_yes" = 0 ] && [ ! -t 0 ]; then
  echo "No terminal for prompts. Run this in a terminal, or pass --yes." >&2
  exit 1
fi

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say()  { printf '%s\n' "$*"; }

# ask "Question" "default" -> echoes the answer (default on Enter or --yes)
ask() {
  if [ "$assume_yes" = 1 ]; then echo "$2"; return; fi
  local reply
  read -r -p "$1 [$2] " reply || reply=""
  echo "${reply:-$2}"
}

# yn "Question" Y|N -> returns 0 for yes. The capital letter is the default.
yn() {
  local def=${2:-Y} hint reply
  [ "$def" = Y ] && hint="Y/n" || hint="y/N"
  if [ "$assume_yes" = 1 ]; then [ "$def" = Y ]; return; fi
  read -r -p "$1 [$hint] " reply || reply=""
  reply=${reply:-$def}
  [[ "$reply" =~ ^[Yy] ]]
}

run() {
  if [ "$dry" = 1 ]; then printf '  + %q' "$1"; shift; printf ' %q' "$@"; printf '\n'; return 0; fi
  "$@"
}

hash_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1; fi
}

we_created=0

write_policy() { # $1 = JSON
  run sudo mkdir -p "$dir" || return 1
  if [ "$dry" = 1 ]; then
    say "  + write $file: $1"
  else
    printf '%s\n' "$1" | sudo tee "$file" >/dev/null || return 1
  fi
  run sudo chown "root:$group" "$file" || return 1
  run sudo chmod 644 "$file" || return 1
  we_created=1
}

remove_policy() {
  if [ -e "$file" ] || [ "$dry" = 1 ]; then run sudo rm -f "$file"; fi
  we_created=0
  say "Policy removed. Sanctum runs unrestricted again."
}

# On any exit, offer to clean up. Default is to remove.
finish() {
  trap - EXIT INT TERM
  if [ "$we_created" = 1 ] && { [ -e "$file" ] || [ "$dry" = 1 ]; }; then
    echo
    if yn "Remove the test policy now?" Y; then remove_policy; else say "Left in place: $file (remove with: sudo rm \"$file\")"; fi
  fi
}
trap finish EXIT
trap 'exit 130' INT TERM

start_app() {
  cd "$repo" || return 1
  if [ ! -d node_modules ]; then
    if yn "node_modules is missing. Run pnpm install first?" Y; then run pnpm install || return 1; fi
  fi
  say "Starting the app (first build can take a few minutes). Quit the app window when you are done."
  run pnpm tauri dev
}

# ── 0. Preflight ──────────────────────────────────────────────────────────────
bold "Sanctum policy test"
if [ "$dry" = 0 ]; then
  command -v pnpm >/dev/null 2>&1 || { echo "pnpm not found." >&2; exit 1; }
  say "sudo is needed to write a root-owned policy file. Asking once now."
  sudo -v || { echo "sudo failed." >&2; exit 1; }
fi

if [ -e "$file" ]; then
  bold "A policy already exists"
  ls -l "$file"; cat "$file"
  case "$(ask "[R]eplace it, [K]eep it and continue, or [Q]uit?" R)" in
    [Rr]*) run sudo rm -f "$file" ;;
    [Kk]*) we_created=0; say "Keeping it." ;;
    *) exit 0 ;;
  esac
fi

# ── 1. Choose and write the policy ────────────────────────────────────────────
if [ ! -e "$file" ] || [ "$dry" = 1 ]; then
  bold "1. What should the policy allow?"
  say "  1) Only the OTP vault example (recommended)"
  say "  2) Only another HTML file"
  say "  3) Nothing (every tool blocked)"
  choice=$(ask "Choose" 1)
  pinned_file="$repo/examples/otp-vault/index.html"
  case "$choice" in
    2)
      pinned_file=$(ask "Path to the HTML file" "$pinned_file")
      pinned_file=${pinned_file/#\~/$HOME}
      ;;
    3) pinned_file="" ;;
    *) ;;
  esac
  if [ -z "$pinned_file" ]; then
    body='{"schema_version":1,"pinned_checksums":[]}'
    expect="every tool is blocked"
  else
    [ -f "$pinned_file" ] || { echo "No such file: $pinned_file" >&2; exit 1; }
    h=$(hash_of "$pinned_file")
    say "Pinning $pinned_file"
    say "  sha256:$h"
    body=$(printf '{"schema_version":1,"pinned_checksums":["sha256:%s"]}' "$h")
    expect="that file opens; every other tool can be added but refuses to open"
  fi
  write_policy "$body" || { echo "Could not write the policy." >&2; exit 1; }
  say "Policy written to $file"
else
  expect="whatever the existing policy says"
fi

# ── 2. Try it ─────────────────────────────────────────────────────────────────
bold "2. Try it in the app"
say "Check:"
say "  - The Library shows a banner about your organisation's policy."
say "  - Expected: $expect."
say "  - A blocked tool's message says the organisation's policy only allows approved tools."
if yn "Start the app now?" Y; then start_app; fi

# ── 3. Broken policy must block everything ────────────────────────────────────
bold "3. A broken policy must block everything"
say "This makes the file writable by everyone, which Sanctum must reject."
if yn "Run this test?" Y; then
  run sudo chmod 666 "$file"
  say "Check: every tool is blocked, and the message says the file is writable by group or others."
  if yn "Start the app again?" Y; then start_app; fi
  run sudo chown "root:$group" "$file"
  run sudo chmod 644 "$file"
  say "File restored to root:$group 644."
fi

# ── 4. Clean up (finish() asks) ───────────────────────────────────────────────
bold "Done"
say "If anything looked wrong, note the exact message shown and send it over."
