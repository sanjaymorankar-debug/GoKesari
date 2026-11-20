#!/usr/bin/env python3
"""
docs/shop-welcome-kit-2026-11: builds the Marathi and Hindi shop-banner
templates from the English one (src/server/shop-banner/assets/template.png).

The English words are removed (white boxes on white, inpainting on the orange
ribbon and band) and the translations drawn in Poppins (SIL OFL 1.1; it covers
Devanagari). The logo, the brand tagline under it and the "GoKesari.com"
line stay as they are (brand). The tagline is written by set-tagline.ts
("Everything for Everyone, Everywhere" since 20-Nov-2026): run that again after
this script. The shop name and QR code are
added later, per shop, by render.ts, in the same places as on the English one.

Run once after changing the English template or a translation, then look at
the results and commit them:
    python3 scripts/shop-banner/make-local-templates.py [POPPINS_DIR]
Needs Pillow with libraqm (Devanagari shaping), OpenCV and numpy.
"""
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, features

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS = os.path.join(ROOT, "src", "server", "shop-banner", "assets")
FONT_DIR = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/google-fonts"
BOLD = os.path.join(ASSETS, "Poppins-Bold.ttf")
SEMIBOLD = os.path.join(FONT_DIR, "Poppins-SemiBold.ttf")
if not os.path.exists(SEMIBOLD):
    SEMIBOLD = BOLD

NAVY = (20, 38, 60)
WHITE = (255, 255, 255)

TEXTS = {
    "mr": {
        "ribbon": "आमचे दुकान आता ऑनलाइन",
        "labels": ["विश्वासार्ह व\nसुरक्षित", "काळजीपूर्वक\nडिलिव्हरी", "सर्वांसाठी,\nसर्वत्र"],
        "qr": "आमच्या दुकानाचा\nQR कोड स्कॅन करा",
        "bottom": "GoKesari सोबत तुमचा व्यवसाय वाढवा",
    },
    "hi": {
        "ribbon": "हमारी दुकान अब ऑनलाइन",
        "labels": ["भरोसेमंद और\nसुरक्षित", "सावधानी से\nडिलीवरी", "सबके लिए,\nहर जगह"],
        "qr": "हमारी दुकान का\nQR कोड स्कैन करें",
        "bottom": "GoKesari के साथ अपना व्यापार बढ़ाएँ",
    },
}

# Areas of the 1536 x 1024 English template.
RIBBON = (395, 312, 1150, 380)      # "We are available on" (white on orange)
BOTTOM = (370, 838, 1175, 924)      # "Grow Your Business with GoKesari" (white on orange)
LABELS = [(180, 596, 368, 680), (494, 596, 682, 680), (782, 596, 1052, 680)]  # on white
QR_HEAD = (1140, 543, 1362, 613)    # "Scan QR Code of Your Shop" (on white)


def inpaint_white_text(img, box):
    """Removes white lettering from a coloured area."""
    arr = np.array(img)
    x0, y0, x1, y1 = box
    region = arr[y0:y1, x0:x1]
    mask = (region.min(axis=2) > 135).astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=2)
    full = np.zeros(arr.shape[:2], np.uint8)
    full[y0:y1, x0:x1] = mask
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    out = cv2.inpaint(bgr, full, 9, cv2.INPAINT_TELEA)
    # Smooth what was filled so no letter shapes show through.
    blur = cv2.GaussianBlur(out, (0, 0), 6)
    soft = cv2.GaussianBlur(full, (0, 0), 3).astype(np.float32)[..., None] / 255.0
    out = (out * (1 - soft) + blur * soft).astype(np.uint8)
    return Image.fromarray(cv2.cvtColor(out, cv2.COLOR_BGR2RGB))


def fit_text(draw, text, font_path, box, max_size, fill, spacing=0.15):
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    size = max_size
    while size > 10:
        font = ImageFont.truetype(font_path, size, layout_engine=ImageFont.Layout.RAQM)
        bbox = draw.multiline_textbbox((0, 0), text, font=font, align="center", spacing=int(size * spacing))
        if bbox[2] - bbox[0] <= w and bbox[3] - bbox[1] <= h:
            break
        size -= 1
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    draw.multiline_text((cx, cy), text, font=font, fill=fill, anchor="mm", align="center", spacing=int(size * spacing))


def build(lang, texts, english):
    img = english.copy()
    img = inpaint_white_text(img, RIBBON)
    img = inpaint_white_text(img, BOTTOM)
    draw = ImageDraw.Draw(img)
    for box in LABELS + [QR_HEAD]:
        draw.rectangle(box, fill=WHITE)
    fit_text(draw, texts["ribbon"], BOLD, (RIBBON[0], RIBBON[1] - 2, RIBBON[2], RIBBON[3] + 2), 62, WHITE)
    fit_text(draw, texts["bottom"], BOLD, BOTTOM, 54, WHITE)
    for box, label in zip(LABELS, texts["labels"]):
        fit_text(draw, label, SEMIBOLD, box, 32, NAVY, spacing=0.35)
    fit_text(draw, texts["qr"], SEMIBOLD, QR_HEAD, 30, NAVY, spacing=0.35)
    out = os.path.join(ASSETS, f"template-{lang}.png")
    img.save(out, optimize=True)
    print("wrote", out)


def main():
    if not features.check("raqm"):
        sys.exit("Pillow needs libraqm for Devanagari shaping.")
    english = Image.open(os.path.join(ASSETS, "template.png")).convert("RGB")
    for lang, texts in TEXTS.items():
        build(lang, texts, english)


if __name__ == "__main__":
    main()
