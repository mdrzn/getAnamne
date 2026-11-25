#!/usr/bin/env python3
"""Anamne 'Recollection' brand icon: a luminous terracotta seed rippling outward
in cream rings on deep ink — a memory being recollected. Drawn at 1024px with a
soft glow and downscaled (LANCZOS) so the 16px favicon stays legible."""
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT, exist_ok=True)

S = 1024
INK = (20, 20, 43, 255)        # #14142B
CREAM = (244, 239, 230, 255)   # #F4EFE6
TERRA = (194, 100, 59, 255)    # #C2643B
cx = cy = S // 2

# Base: ink, clipped to a rounded square.
base = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(base).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=INK)

# Warm glow behind the seed (depth).
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gr = int(S * 0.30)
gd.ellipse([cx - gr, cy - gr, cx + gr, cy + gr], fill=(194, 100, 59, 150))
glow = glow.filter(ImageFilter.GaussianBlur(int(S * 0.10)))
base = Image.alpha_composite(base, glow)

d = ImageDraw.Draw(base)

def ring(r, width, color, start=None, end=None):
    box = [cx - r, cy - r, cx + r, cy + r]
    if start is None:
        d.ellipse(box, outline=color, width=width)
    else:
        d.arc(box, start, end, fill=color, width=width)

# Outer ripple — a 280° cream arc (gap reads as a memory 'opening').
ring(int(S * 0.40), int(S * 0.052), CREAM, start=120, end=120 + 280)
# Inner full ring, cream.
ring(int(S * 0.265), int(S * 0.058), CREAM)
# The seed.
r0 = int(S * 0.125)
d.ellipse([cx - r0, cy - r0, cx + r0, cy + r0], fill=TERRA)

for size in (16, 32, 48, 128):
    base.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))
    print("wrote", f"icon{size}.png")
base.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "icon512.png"))
print("wrote icon512.png")
