#!/usr/bin/env python3
"""Generate the static Patron invite Open Graph image (1200x630, <300KB).

Served by supabase/functions/invite as the og:image fallback. The inviter's
first name is NOT baked into this static asset — it travels in og:title /
og:description only (Phase 3's explicit fallback). Patron purple #6366F1.

Regenerate with:  python3 scripts/generate-invite-og.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
PURPLE = (99, 102, 241, 255)      # #6366F1
PURPLE_DARK = (79, 70, 229, 255)  # #4F46E5
WHITE = (255, 255, 255, 255)
WHITE_SOFT = (224, 228, 255, 255)

OUT = os.path.join(os.path.dirname(__file__), "..", "supabase", "functions", "invite", "og.png")


def font(size: int, bold: bool = False):
    candidates = []
    if bold:
        candidates += [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Supplemental/HelveticaNeue.ttc",
        ]
    candidates += [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    return ImageFont.load_default(size if hasattr(ImageFont, "load_default") else None)


def main() -> None:
    img = Image.new("RGBA", (W, H), PURPLE)
    d = ImageDraw.Draw(img)

    # Soft vertical accent band on the left — subtle, on-brand.
    d.rectangle([0, 0, 14, H], fill=PURPLE_DARK)

    wordmark = font(150, bold=True)
    tagline = font(46, bold=False)
    sub = font(28, bold=False)

    def center_w(draw: ImageDraw.ImageDraw, y: int, text: str, f, fill):
        box = draw.textbbox((0, 0), text, font=f)
        w = box[2] - box[0]
        draw.text(((W - w) / 2, y), text, font=f, fill=fill)

    center_w(d, 190, "Patron", wordmark, WHITE)
    center_w(d, 380, "Tes ventes, tes crédits — même sans internet.", tagline, WHITE_SOFT)
    center_w(d, 470, "Gratuit · Fait pour les commerçants", sub, WHITE_SOFT)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.convert("RGB").save(OUT, "PNG", optimize=True)
    size = os.path.getsize(OUT)
    print(f"wrote {OUT} ({size} bytes)")


if __name__ == "__main__":
    main()
