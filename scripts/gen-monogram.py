#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Enigma Technologies Solutions
"""Generate the Sanctum "st" monogram from the self-hosted Poppins 700 outlines.

Writes:
  assets/logo/st-monogram.svg  full-bleed mark (favicon, in-app header)
  assets/logo/app-icon.svg     macOS 1024 grid: 824 body, 100 margin

Then build the platform icons from a 1024 px PNG of app-icon.svg:
  pnpm tauri icon app-icon-1024.png -o /tmp/icons
and copy the five files tauri.conf.json lists into src-tauri/icons/.

Requires: pip install fonttools brotli
"""
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
INK, VOLT, PAPER = "#0A0A0A", "#FBFF00", "#FFFFFF"
TRACKING = -20      # font units between s and t
DOT, DOT_GAP = 150, 70  # volt terminal square and its gap, font units


def glyphs(text: str):
    font = TTFont(ROOT / "web/assets/fonts/Poppins-700.woff2")
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    x, parts, box = 0, [], [1e9, 1e9, -1e9, -1e9]
    for ch in text:
        g = gs[cmap[ord(ch)]]
        pen, bp = SVGPathPen(gs), BoundsPen(gs)
        g.draw(pen)
        g.draw(bp)
        b = bp.bounds
        parts.append((x, pen.getCommands()))
        box = [min(box[0], x + b[0]), min(box[1], b[1]), max(box[2], x + b[2]), max(box[3], b[3])]
        x += g.width + TRACKING
    return parts, box


def mark(size, pad, frame_inset, frame_w, letter_frac):
    parts, (xmin, ymin, xmax, ymax) = glyphs("st")
    body = size - 2 * pad
    w_units = (xmax - xmin) + DOT_GAP + DOT
    s = letter_frac * body / w_units
    tx = pad + (body - w_units * s) / 2 - xmin * s
    baseline = pad + (body + (ymax - ymin) * s) / 2 + ymin * s
    fi = pad + frame_inset + frame_w / 2
    inner = body - 2 * frame_inset - frame_w
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">',
        "  <title>Sanctum</title>",
        f'  <rect x="{pad}" y="{pad}" width="{body}" height="{body}" fill="{INK}"/>',
        f'  <rect x="{fi:.2f}" y="{fi:.2f}" width="{inner:.2f}" height="{inner:.2f}" fill="none" stroke="{VOLT}" stroke-width="{frame_w}"/>',
        f'  <g fill="{PAPER}" transform="translate({tx:.2f} {baseline:.2f}) scale({s:.5f} {-s:.5f})">',
    ]
    out += [f'    <path transform="translate({x} 0)" d="{d}"/>' for x, d in parts]
    dx = tx + (xmax + DOT_GAP) * s
    out += [
        "  </g>",
        f'  <rect x="{dx:.2f}" y="{baseline - DOT * s:.2f}" width="{DOT * s:.2f}" height="{DOT * s:.2f}" fill="{VOLT}"/>',
        "</svg>",
    ]
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    out = ROOT / "assets/logo"
    out.mkdir(parents=True, exist_ok=True)
    (out / "app-icon.svg").write_text(mark(1024, 100, 64, 26, 0.60))
    (out / "st-monogram.svg").write_text(mark(64, 0, 5, 3, 0.64))
    print("wrote", out / "app-icon.svg", out / "st-monogram.svg")
