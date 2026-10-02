#!/usr/bin/env python3
"""Writes the icon SVG sources (stdlib only).

The mark is a 3x5 pixel "ETS" plus a volt bar, all on one cell grid:
wordmark = 11 cells wide, letters 5 tall, 1 cell gap, bar 1 cell tall.
Every shape has square corners. Only the body shape changes per target.
"""
import math, os

INK, WHITE, VOLT = "#0A0A0A", "#FFFFFF", "#FBFF00"
# Letters as overlapping rects (x, y, w, h) in cells.
LETTERS = {
    "E": [(0, 0, 1, 5), (0, 0, 3, 1), (0, 2, 3, 1), (0, 4, 3, 1)],
    "T": [(0, 0, 3, 1), (1, 0, 1, 5)],
    "S": [(0, 0, 3, 1), (0, 0, 1, 3), (0, 2, 3, 1), (2, 2, 1, 3), (0, 4, 3, 1)],
}
HERE = os.path.dirname(os.path.abspath(__file__))


def f(v):
    return ("%.3f" % v).rstrip("0").rstrip(".")


def mark(x0, y0, u):
    """Wordmark + bar with its top-left at (x0, y0), cell size u."""
    out = []
    for i, ch in enumerate("ETS"):
        ox = x0 + i * 4 * u
        for (x, y, w, h) in LETTERS[ch]:
            out.append('<rect x="%s" y="%s" width="%s" height="%s"/>' % (f(ox + x * u), f(y0 + y * u), f(w * u), f(h * u)))
    letters = '<g fill="%s">%s</g>' % (WHITE, "".join(out))
    bar = '<rect x="%s" y="%s" width="%s" height="%s" fill="%s"/>' % (f(x0), f(y0 + 6 * u), f(11 * u), f(u), VOLT)
    return letters + bar


def squircle(cx, cy, half, n=4.4, pts=240):
    d = []
    for k in range(pts):
        t = 2 * math.pi * k / pts
        c, s = math.cos(t), math.sin(t)
        x = cx + half * math.copysign(abs(c) ** (2 / n), c)
        y = cy + half * math.copysign(abs(s) ** (2 / n), s)
        d.append(("M" if k == 0 else "L") + "%s %s" % (f(x), f(y)))
    return "".join(d) + "Z"


def svg(size, body, art, title):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">\n'
            '<title>%s</title>\n%s\n%s\n</svg>\n' % (size, size, size, size, title, body, art))


def write(name, text):
    with open(os.path.join(HERE, name), "w") as fh:
        fh.write(text)


def squircle_body(size, side, edge):
    c = size / 2
    d = squircle(c, c, side / 2)
    s = '<path d="%s" fill="%s"/>' % (d, INK)
    if edge:
        # Faint light rim so the ink body separates from dark Docks and taskbars.
        s += '<path d="%s" fill="none" stroke="#FFFFFF" stroke-opacity=".16" stroke-width="%s"/>' % (
            squircle(c, c, side / 2 - edge / 2), f(edge))
    return s


# macOS master: 1024 canvas, 824 body (Apple grid), transparent margin.
u = 58
x0 = 512 - 11 * u / 2
y0 = 512 - 7 * u / 2 - 10
write("master.svg", svg(1024, squircle_body(1024, 824, 6), mark(x0, y0, u), "Sanctum macOS master"))

# Flat square, full bleed (Windows large sizes). Same art scaled to fill 1024.
k = 1024 / 824
u2 = 58 * k
write("flat.svg", svg(1024, '<rect width="1024" height="1024" fill="%s"/>' % INK,
                      mark(512 - 11 * u2 / 2, 512 - 7 * u2 / 2 - 10 * k, u2), "Sanctum flat square"))

# Linux: squircle body filling the canvas (launchers do not add margin).
write("linux.svg", svg(1024, squircle_body(1024, 1008, 6).replace('stroke-width="6"', 'stroke-width="6"'),
                       mark(512 - 11 * u2 / 2, 512 - 7 * u2 / 2 - 10 * k, u2), "Sanctum Linux"))

# Hand-tuned pixel-grid sizes: integer cell, integer origin, so every edge lands on a pixel.
# (size, cell, x0, y0)
GRID = {16: (1, 2, 4), 24: (2, 1, 5), 32: (2, 5, 9), 48: (3, 7, 13), 64: (4, 10, 18)}
for n, (cell, gx, gy) in GRID.items():
    art = '<g shape-rendering="crispEdges">%s</g>' % mark(gx, gy, cell)
    write("small-%d.svg" % n, svg(n, '<rect width="%d" height="%d" fill="%s"/>' % (n, n, INK), art, "Sanctum %dpx flat" % n))

# macOS small sizes (Finder lists, 1x/2x small): rounded body, pixel-aligned mark.
# (size, body side, cell, x0, y0)
MAC = {16: (16, 1, 2, 4), 32: (30, 2, 5, 9), 64: (58, 4, 10, 18)}
for n, (side, cell, gx, gy) in MAC.items():
    art = '<g shape-rendering="crispEdges">%s</g>' % mark(gx, gy, cell)
    write("mac-small-%d.svg" % n, svg(n, squircle_body(n, side, 0), art, "Sanctum macOS %dpx" % n))
