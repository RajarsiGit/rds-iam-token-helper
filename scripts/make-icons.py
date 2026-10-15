#!/usr/bin/env python3
"""Draws the extension icon (database cylinder + gold key on an indigo->teal tile)
and writes icons/icon{16,32,48,128}.png.   Run: python3 scripts/make-icons.py"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw

S = 8                      # supersampling: design units -> pixels
N = 128 * S                # master canvas
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")


def u(v):
    return v * S


def lerp(a, b, t):
    return a + (b - a) * t


def gradient(c0, c1, horizontal=False, diagonal=False):
    y, x = np.mgrid[0:N, 0:N].astype(np.float32)
    t = (x + y) / (2 * N) if diagonal else (x / N if horizontal else y / N)
    t = t[..., None]
    c0 = np.array(c0, np.float32)
    c1 = np.array(c1, np.float32)
    return Image.fromarray((c0 + (c1 - c0) * t).astype(np.uint8), "RGB")


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mask():
    return Image.new("L", (N, N), 0)


# ---- background tile ----
bg = gradient(hexrgb("#3730a3"), hexrgb("#0891b2"), diagonal=True)
canvas = bg.copy()

# ---- database cylinder ----
CX0, CX1 = 18, 82          # left / right edge
TOP_Y, BOT_Y = 34, 88      # centres of top and bottom ellipses
RY = 12                    # ellipse half-height

sil = mask()
d = ImageDraw.Draw(sil)
d.rectangle([u(CX0), u(TOP_Y), u(CX1), u(BOT_Y)], fill=255)
d.ellipse([u(CX0), u(BOT_Y - RY), u(CX1), u(BOT_Y + RY)], fill=255)
d.ellipse([u(CX0), u(TOP_Y - RY), u(CX1), u(TOP_Y + RY)], fill=255)

body = gradient(hexrgb("#ffffff"), hexrgb("#a5b4fc"), horizontal=True)
canvas.paste(body, mask=sil)

line = ImageDraw.Draw(canvas)
band = hexrgb("#818cf8")
for y in (TOP_Y + 20, TOP_Y + 38):   # two curved separators
    line.arc([u(CX0), u(y - RY), u(CX1), u(y + RY)], 0, 180, fill=band, width=u(4))

# top face (lighter) with a thin rim
line.ellipse([u(CX0), u(TOP_Y - RY), u(CX1), u(TOP_Y + RY)], fill=hexrgb("#ffffff"), outline=band, width=u(3))

# ---- gold key (bow lower right, shaft pointing up-left) ----
KX, KY = 94, 94
ANG = math.radians(225)    # shaft direction
ca, sa = math.cos(ANG), math.sin(ANG)


def to_canvas(lx, ly):
    return (u(KX + lx * ca - ly * sa), u(KY + lx * sa + ly * ca))


def rect_poly(x0, x1, y0, y1, grow):
    pts = [(x0 - grow, y0 - grow), (x1 + grow, y0 - grow), (x1 + grow, y1 + grow), (x0 - grow, y1 + grow)]
    return [to_canvas(px, py) for px, py in pts]


def key_shapes(draw, grow, with_hole):
    r = 18 + grow
    draw.ellipse([u(KX - r), u(KY - r), u(KX + r), u(KY + r)], fill=255)
    draw.polygon(rect_poly(10, 52, -5.5, 5.5, grow), fill=255)       # shaft
    draw.polygon(rect_poly(39, 48, 5.5, 15, grow), fill=255)         # tooth 1
    draw.polygon(rect_poly(26, 35, 5.5, 12.5, grow), fill=255)       # tooth 2
    if with_hole:
        h = 7
        draw.ellipse([u(KX - h), u(KY - h), u(KX + h), u(KY + h)], fill=0)


outline = mask()
key_shapes(ImageDraw.Draw(outline), grow=4.5, with_hole=False)
canvas.paste(bg, mask=outline)                       # cut-out in tile colour around the key

key = mask()
key_shapes(ImageDraw.Draw(key), grow=0, with_hole=True)
gold = gradient(hexrgb("#fde68a"), hexrgb("#f59e0b"))
canvas.paste(gold, mask=key)

# ---- rounded tile alpha ----
tile = mask()
ImageDraw.Draw(tile).rounded_rectangle([0, 0, N - 1, N - 1], radius=u(28), fill=255)
master = canvas.convert("RGBA")
master.putalpha(tile)

os.makedirs(OUT, exist_ok=True)
for size in (16, 32, 48, 128):
    img = master.resize((size, size), Image.LANCZOS)
    img.save(os.path.join(OUT, f"icon{size}.png"), optimize=True)
    print("wrote", f"icons/icon{size}.png")

# preview sheet (not shipped): all sizes on light and dark backgrounds
sheet = Image.new("RGBA", (560, 300), (255, 255, 255, 255))
dark = Image.new("RGBA", (560, 150), (32, 33, 36, 255))
sheet.paste(dark, (0, 150))
x = 16
for size in (128, 48, 32, 16):
    ic = master.resize((size, size), Image.LANCZOS)
    for y0 in (10, 160):
        sheet.paste(ic, (x, y0), ic)
    x += size + 24
x = 330
for size in (16, 32):   # magnified, to judge legibility at toolbar size
    ic = master.resize((size, size), Image.LANCZOS).resize((size * 4, size * 4), Image.NEAREST)
    sheet.paste(ic, (x, 10), ic)
    x += size * 4 + 16
sheet.save(os.path.join(os.path.dirname(__file__), "..", "icon-preview.png"))
