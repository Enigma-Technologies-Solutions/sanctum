#!/usr/bin/env bash
# Rebuilds every file in src-tauri/icons from the SVG sources here.
# Run from the repo root: src-tauri/icons/source/build-icons.sh
# Needs: python3, ImageMagick (magick), iconutil (macOS only, for icon.icns).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$(dirname "$SRC")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 "$SRC/gen-svgs.py"

# svg2png <svg> <size> <out>  (large art: ImageMagick renders 1024, then resizes)
svg2png() { magick -background none -density 96 "$SRC/$1" -filter Lanczos -resize "$2x$2" -depth 8 "PNG32:$3"; }
# pix <small-svg> <out>  (pixel-exact; see raster-small.py)
pix() { python3 "$SRC/raster-small.py" "$SRC/$1" "$2"; }

# Dock-style drop shadow inside the transparent margin (macOS master only).
shadowed() { # <in.png> <size> <out.png>
  local s=$2
  magick "$1" \( +clone -background black -shadow 45x$((s*12/1024+1))+0+$((s*10/1024)) \) +swap \
    -background none -layers merge +repage -gravity center -extent "${s}x${s}" "PNG32:$3"
}

# Linux / Tauri PNGs
pix mac-small-32.svg "$OUT/32x32.png"
svg2png linux.svg 128 "$OUT/128x128.png"
svg2png linux.svg 256 "$OUT/128x128@2x.png"
svg2png linux.svg 512 "$OUT/icon.png"

# Windows .ico: pixel-tuned 16..64, scaled flat art above
for n in 16 24 32 48 64; do pix "small-$n.svg" "$TMP/w$n.png"; done
for n in 128 256; do svg2png flat.svg "$n" "$TMP/w$n.png"; done
magick "$TMP"/w16.png "$TMP"/w24.png "$TMP"/w32.png "$TMP"/w48.png "$TMP"/w64.png \
  "$TMP"/w128.png "$TMP"/w256.png "$OUT/icon.ico"

# macOS .icns
if command -v iconutil >/dev/null; then
  IS="$TMP/icon.iconset"; mkdir "$IS"
  big() { svg2png master.svg "$1" "$TMP/m$1.png"; shadowed "$TMP/m$1.png" "$1" "$IS/$2"; }
  pix mac-small-16.svg "$IS/icon_16x16.png"
  pix mac-small-32.svg "$IS/icon_16x16@2x.png"
  pix mac-small-32.svg "$IS/icon_32x32.png"
  pix mac-small-64.svg "$IS/icon_32x32@2x.png"
  big 128  icon_128x128.png
  big 256  icon_128x128@2x.png
  big 256  icon_256x256.png
  big 512  icon_256x256@2x.png
  big 512  icon_512x512.png
  big 1024 icon_512x512@2x.png
  iconutil --convert icns --output "$OUT/icon.icns" "$IS"
fi
echo "icons written to $OUT"
