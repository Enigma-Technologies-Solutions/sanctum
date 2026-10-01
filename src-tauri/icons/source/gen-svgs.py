#!/usr/bin/env python3
"""Writes the icon SVG sources (stdlib only).

The mark is the website favicon's concentric squares: ink field, two volt
outline squares, solid volt centre square. The favicon's translucent outlines
(35% and 60%) are pre-blended onto ink so nothing depends on alpha. Every
shape has square corners. Only the body shape and the detail level change
per target size.
"""
import math, os

INK, VOLT = "#0A0A0A", "#FBFF00"
OUTER, MID = "#5E6007", "#9B9D04"   # volt at 35% and 60% over ink
HERE = os.path.dirname(os.path.abspath(__file__))


def f(v):
    return ("%.3f" % v).rstrip("0").rstrip(".")


def rect(x, y, w, h, fill):
    return '<rect x="%s" y="%s" width="%s" height="%s" fill="%s"/>' % (f(x), f(y), f(w), f(h), fill)


def frame(cx, cy, half, stroke, fill):
    """Square outline: outer edge at +-half, `stroke` thick, as four overlapping rects."""
    o, s = half, stroke
    return "".join([
        rect(cx - o, cy - o, 2 * o, s, fill), rect(cx - o, cy + o - s, 2 * o, s, fill),
        rect(cx - o, cy - o, s, 2 * o, fill), rect(cx + o - s, cy - o, s, 2 * o, fill)])


def mark(cx, cy, c, frames):
    """c = half size of centre square; frames = [(outer half, stroke, colour), ...] outermost first."""
    out = "".join(frame(cx, cy, h, s, col) for h, s, col in frames)
    return out + rect(cx - c, cy - c, 2 * c, 2 * c, VOLT)


def large(cx, cy, u):
    """Full three-layer mark, favicon proportions, strokes thickened for a Dock."""
    return mark(cx, cy, 6 * u, [(25.5 * u, 3 * u, OUTER), (15.5 * u, 3 * u, MID)])


def squircle(cx, cy, half, n=4.4, pts=240):
    d = []
    for k in range(pts):
        t = 2 * math.pi * k / pts
        c, s = math.cos(t), math.sin(t)
        x = cx + half * math.copysign(abs(c) ** (2 / n), c)
        y = cy + half * math.copysign(abs(s) ** (2 / n), s)
        d.append(("M" if k == 0 else "L") + "%s %s" % (f(x), f(y)))
    return "".join(d) + "Z"


def squircle_body(size, side, edge):
    c = size / 2
    s = '<path d="%s" fill="%s"/>' % (squircle(c, c, side / 2), INK)
    if edge:
        # Faint light rim so the ink body separates from dark Docks and taskbars.
        s += '<path d="%s" fill="none" stroke="#FFFFFF" stroke-opacity=".16" stroke-width="%s"/>' % (
            squircle(c, c, side / 2 - edge / 2), f(edge))
    return s


def svg(size, body, art, title):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">\n'
            '<title>%s</title>\n%s\n%s\n</svg>\n' % (size, size, size, size, title, body, art))


def write(name, text):
    with open(os.path.join(HERE, name), "w") as fh:
        fh.write(text)


# macOS master: 1024 canvas, 824 body (Apple grid), transparent margin.
write("master.svg", svg(1024, squircle_body(1024, 824, 6), large(512, 512, 824 / 64), "Sanctum macOS master"))
# Windows large sizes: flat full-bleed square.
write("flat.svg", svg(1024, '<rect width="1024" height="1024" fill="%s"/>' % INK, large(512, 512, 16), "Sanctum flat square"))
# Linux: squircle filling the canvas.
write("linux.svg", svg(1024, squircle_body(1024, 1008, 6), large(512, 512, 1008 / 64), "Sanctum Linux"))

# Hand-tuned pixel-grid sizes: integer geometry, so every edge lands on a pixel.
# Each entry: centre half c, then frames (outer half, stroke, colour), outermost first.
FLAT = {
    64: (4, [(25, 3, OUTER), (14, 3, MID)]),
    48: (3, [(19, 3, OUTER), (10, 3, MID)]),
    32: (3, [(10, 3, MID)]),
    24: (2, [(8, 2, MID)]),
    16: (2, [(6, 2, VOLT)]),
}
for n, (c, fr) in FLAT.items():
    write("small-%d.svg" % n, svg(n, rect(0, 0, n, n, INK), mark(n // 2, n // 2, c, fr), "Sanctum %dpx flat" % n))

# macOS small sizes (Finder lists): rounded body (side), same idea, kept off the curve.
MAC = {
    64: (58, 4, [(23, 3, OUTER), (13, 3, MID)]),
    32: (30, 3, [(9, 3, MID)]),
    16: (16, 2, [(6, 2, VOLT)]),
}
for n, (side, c, fr) in MAC.items():
    write("mac-small-%d.svg" % n, svg(n, squircle_body(n, side, 0), mark(n // 2, n // 2, c, fr), "Sanctum macOS %dpx" % n))
