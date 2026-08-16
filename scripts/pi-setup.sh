#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Enigma Technologies Solutions
#
# One-time setup for building and running Sanctum on Raspberry Pi OS
# (Bookworm, 64-bit) — Pi 400, Pi 4, Pi 5.
#
#   curl -fsSL <raw-url>/scripts/pi-setup.sh | bash
#   …or, from a clone:  ./scripts/pi-setup.sh
#
# Installs the GTK/WebKit toolchain Tauri needs, the PC/SC stack the smart card
# broker needs, Rust, and Node+pnpm. Re-running is safe.

set -euo pipefail

say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Sanity ────────────────────────────────────────────────────────────────────

[ "$(uname -s)" = "Linux" ] || die "this script is for Raspberry Pi OS / Linux"

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64) ;;
  armv7l|armv6l)
    die "32-bit Raspberry Pi OS detected ($ARCH).
   WebKitGTK on armhf is not a supported Tauri target in practice.
   Reflash with the 64-bit image (Raspberry Pi Imager → Raspberry Pi OS (64-bit))." ;;
  *) say "unrecognised architecture $ARCH — continuing, but you are off the tested path" ;;
esac

say "Updating package lists"
sudo apt-get update

# ── Build toolchain ───────────────────────────────────────────────────────────
#
# libwebkit2gtk-4.1-dev is the one that matters: Tauri v2 targets the 4.1 API,
# and Bookworm ships it. Bullseye only has 4.0 — upgrade the OS rather than
# fighting that.

say "Installing build dependencies"
sudo apt-get install -y \
  build-essential curl wget file git pkg-config \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  patchelf

# ── PC/SC ─────────────────────────────────────────────────────────────────────
#
# libpcsclite-dev is needed to build (the pcsc crate links against it); pcscd
# and libccid are needed to run — pcscd is the resource manager every reader
# goes through, libccid is the driver for USB CCID readers, which is nearly all
# of them including the Cryptknox/ACR-class contactless ones.

say "Installing the smart card stack (PC/SC)"
sudo apt-get install -y libpcsclite-dev pcscd libccid pcsc-tools

say "Enabling pcscd"
sudo systemctl enable --now pcscd || say "could not enable pcscd via systemd — start it by hand before running Sanctum"

# ── Rust ──────────────────────────────────────────────────────────────────────

if command -v cargo >/dev/null 2>&1; then
  say "Rust already installed: $(cargo --version)"
else
  say "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

# ── Node + pnpm ───────────────────────────────────────────────────────────────

if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -c2- | cut -d. -f1)" -ge 20 ]; then
  say "Node already installed: $(node -v)"
else
  say "Installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if command -v pnpm >/dev/null 2>&1; then
  say "pnpm already installed: $(pnpm --version)"
else
  say "Installing pnpm"
  sudo npm install -g pnpm@10
fi

# ── Swap ──────────────────────────────────────────────────────────────────────
#
# A Pi 400 has 4 GB and no swap worth the name by default. Linking a Tauri
# binary is the peak, and the default 100 MB swapfile is where builds die.

CURRENT_SWAP=$(free -m | awk '/^Swap:/ {print $2}')
if [ "${CURRENT_SWAP:-0}" -lt 2000 ]; then
  say "Swap is ${CURRENT_SWAP:-0} MB — raising to 2 GB so the link step does not get OOM-killed"
  sudo dphys-swapfile swapoff || true
  sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
  sudo sed -i 's/^#\?CONF_MAXSWAP=.*/CONF_MAXSWAP=2048/' /etc/dphys-swapfile
  sudo dphys-swapfile setup
  sudo dphys-swapfile swapon
else
  say "Swap is ${CURRENT_SWAP} MB — fine"
fi

# ── Reader check ──────────────────────────────────────────────────────────────

say "Readers visible to PC/SC"
if command -v pcsc_scan >/dev/null 2>&1; then
  timeout 5 pcsc_scan -r 2>/dev/null || echo "  (none — plug the reader in, then re-run: pcsc_scan -r)"
fi

say "Setup complete. Next: ./scripts/pi-build.sh"
