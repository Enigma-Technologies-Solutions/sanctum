#!/usr/bin/env python3
"""Pixel-exact rasteriser for the small-*.svg and mac-small-*.svg sources.

ImageMagick's built-in SVG renderer rounds tiny rects unpredictably, so the
hand-tuned sizes are drawn here instead. Usage: raster-small.py in.svg out.png
Reads only what gen-svgs.py writes: <rect> elements (axis-aligned, integer
grid) and one optional body <path> made of M/L points (anti-aliased 8x).
"""
import re, sys
from PIL import Image, ImageDraw

svg = open(sys.argv[1]).read()
size = int(re.search(r'width="(\d+)"', svg).group(1))
SS = 8


def colour(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4)) + (255,)


img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
path = re.search(r'<path d="([^"]+)" fill="(#[0-9A-Fa-f]{6})"/>', svg)
if path:
    big = Image.new("L", (size * SS, size * SS), 0)
    pts = [(float(a) * SS, float(b) * SS) for a, b in re.findall(r"[ML]([-\d.]+) ([-\d.]+)", path.group(1))]
    ImageDraw.Draw(big).polygon(pts, fill=255)
    mask = big.resize((size, size), Image.LANCZOS)
    img.paste(Image.new("RGBA", (size, size), colour(path.group(2))), (0, 0), mask)

d = ImageDraw.Draw(img)
fill = "#FFFFFF"
for m in re.finditer(r'<g fill="(#[0-9A-Fa-f]{6})">|<rect ([^>]*)/>', svg):
    if m.group(1):
        fill = m.group(1)
        continue
    a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(2)))
    w, h = int(float(a["width"])), int(float(a["height"]))
    x, y = int(float(a.get("x", 0))), int(float(a.get("y", 0)))
    c = colour(a.get("fill", fill))
    if not path and w == size and h == size:
        c = colour(a["fill"])
    d.rectangle([x, y, x + w - 1, y + h - 1], fill=c)
img.save(sys.argv[2])
