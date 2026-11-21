/**
 * docs/shop-welcome-kit-2026-11: writes the third feature label (under the people icon) on the three shop-banner
 * templates. The owner's design said "For Everyone, At Everywhere"; on 21-Nov-2026 the owner chose:
 *   English  "Everything For Everyone, Everywhere"
 *   Marathi  "सर्वांसाठी सर्व काही, सर्वत्र"   (everything for everyone, everywhere)
 *   Hindi    "सबके लिए सब कुछ, हर जगह"
 *
 * The label sits on plain white between two thin dividers, so the old words are painted white and the new ones
 * drawn there: two centred lines, Poppins Bold, the design's navy, as large as fits the old label's box.
 * Safe to run again (it repaints the same box).
 *
 *     node --import tsx scripts/shop-banner/set-everywhere-label.ts
 *
 * make-local-templates.py has the same Marathi / Hindi words in TEXTS; after re-running it, run this script and
 * set-tagline.ts again.
 */
import path from "node:path";

import sharp from "sharp";

const ASSETS = path.join(process.cwd(), "src", "server", "shop-banner", "assets");
const FONT_FILE = path.join(ASSETS, "Poppins-Bold.ttf");
process.env.FONTCONFIG_FILE ??= path.join(ASSETS, "fonts.conf");
process.env.PANGOCAIRO_BACKEND ??= "fc";

export const EVERYWHERE_LABEL: Record<"en" | "mr" | "hi", [string, string]> = {
  en: ["Everything For Everyone,", "Everywhere"],
  mr: ["सर्वांसाठी सर्व काही,", "सर्वत्र"],
  hi: ["सबके लिए सब कुछ,", "हर जगह"],
};
const FILES = { en: "template.png", mr: "template-mr.png", hi: "template-hi.png" } as const;

// Old navy lettering just under the icon (Devanagari vowel signs reach y 594 on the Marathi / Hindi templates):
// cleared colour by colour so the orange icon above is kept.
const UNDER_ICON = { left: 745, top: 584, width: 323, height: 13 };

// Pixel geometry of the 1536 x 1024 templates (measured on the owner's design).
const CLEAR = { left: 745, top: 597, width: 323, height: 88 }; // white between the dividers (x 740 / 1073), icon above, name box below
const BOX = { centreX: 906, top: 603, maxWidth: 314, maxHeight: 74 }; // the old label's ink: x 793-1037, y 606-675
const NAVY = { r: 20, g: 38, b: 60 };

async function render(lines: [string, string]): Promise<{ png: Buffer; width: number; height: number }> {
  const text = lines.map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;")).join("\n");
  for (let size = 40; size >= 14; size -= 1) {
    const { data, info } = await sharp({ text: { text, font: `Poppins Bold ${size}`, fontfile: FONT_FILE, dpi: 72, align: "centre", spacing: 2 } })
      .extractChannel(0)
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width > BOX.maxWidth || info.height > BOX.maxHeight) continue;
    const rgba = Buffer.alloc(info.width * info.height * 4);
    for (let i = 0; i < info.width * info.height; i++) {
      rgba[i * 4] = NAVY.r; rgba[i * 4 + 1] = NAVY.g; rgba[i * 4 + 2] = NAVY.b; rgba[i * 4 + 3] = data[i];
    }
    const png = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
    return { png, width: info.width, height: info.height };
  }
  throw new Error(`label does not fit: ${lines.join(" / ")}`);
}

async function main(): Promise<void> {
  const white = await sharp({ create: { width: CLEAR.width, height: CLEAR.height, channels: 4, background: "#ffffff" } }).png().toBuffer();
  for (const lang of ["en", "mr", "hi"] as const) {
    const label = await render(EVERYWHERE_LABEL[lang]);
    const target = path.join(ASSETS, FILES[lang]);
    const left = Math.round(BOX.centreX - label.width / 2);
    const top = BOX.top + Math.round((BOX.maxHeight - label.height) / 2);
    const raw = await sharp(target).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const W = raw.info.width;
    for (let y = UNDER_ICON.top; y < UNDER_ICON.top + UNDER_ICON.height; y++)
      for (let x = UNDER_ICON.left; x < UNDER_ICON.left + UNDER_ICON.width; x++) {
        const i = (y * W + x) * 3;
        const [r, g, b] = [raw.data[i], raw.data[i + 1], raw.data[i + 2]];
        if (r - b < 60 && Math.min(r, g, b) < 250) raw.data.fill(255, i, i + 3); // navy / grey ink, not the orange icon
      }
    const base = await sharp(raw.data, { raw: { width: W, height: raw.info.height, channels: 3 } }).png().toBuffer();
    const out = await sharp(base)
      .composite([{ input: white, left: CLEAR.left, top: CLEAR.top }, { input: label.png, left, top }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    await sharp(out).toFile(target);
    console.log(`${FILES[lang]}: "${EVERYWHERE_LABEL[lang].join(" ")}" (${label.width} x ${label.height} px at x ${left}, y ${top})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
