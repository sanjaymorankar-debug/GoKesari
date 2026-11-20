/**
 * docs/shop-welcome-kit-2026-11: writes the brand tagline under the GoKesari logo on the three shop-banner
 * templates (src/server/shop-banner/assets/template{,-hi,-mr}.png), so the printed banner says what the site says.
 * The owner's design had "Everything for Everyone."; on 20-Nov-2026 the owner made it
 * "Everything for Everyone, Everywhere" across the site (PR #430, BRAND_TAGLINE).
 *
 * The strip between the logo and the orange ribbon is plain white on all three templates, so the old line and its
 * two dashes are painted white and the new line drawn in its place: Poppins Bold, the template's orange, centred on
 * the logo, with a dash either side. Safe to run again (it repaints the same strip).
 *
 *     node --import tsx scripts/shop-banner/set-tagline.ts ["Everything for Everyone, Everywhere"]
 *
 * Then look at the three files and commit them. make-local-templates.py copies the strip from the English template,
 * so after re-running that script run this one again.
 */
import path from "node:path";

import sharp from "sharp";

const ASSETS = path.join(process.cwd(), "src", "server", "shop-banner", "assets");
const FONT_FILE = path.join(ASSETS, "Poppins-Bold.ttf");
process.env.FONTCONFIG_FILE ??= path.join(ASSETS, "fonts.conf");
process.env.PANGOCAIRO_BACKEND ??= "fc";

const TAGLINE = process.argv[2] ?? "Everything for Everyone, Everywhere";
const TEMPLATES = ["template.png", "template-hi.png", "template-mr.png"];

// Pixel geometry of the 1536 x 1024 templates (measured on the owner's design).
const STRIP = { left: 390, top: 257, width: 760, height: 39 }; // white between the logo (ends y 255) and the ribbon (from y 296)
const CENTRE_X = 762; // the logo's centre line
const TEXT_TOP = 264; // ink top of the old line (ascenders); its descenders ended at y 296
const MAX_TEXT_WIDTH = 640; // keeps clear of the sun rays (x < 378 and x > 1157 at the text's height)
const ORANGE = { r: 238, g: 91, b: 20 }; // the old line's ink
const DASH = { length: 50, gap: 14, top: 276, height: 5 }; // y 277-279 solid, one soft row each side, like the old dashes

async function textMask(size: number): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp({ text: { text: TAGLINE, font: `Poppins Bold ${size}`, fontfile: FONT_FILE, dpi: 72 } })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Trim to the ink so the line is placed by what is drawn, not by the font's line box.
  let x0 = info.width, x1 = -1, y0 = info.height, y1 = -1;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[y * info.width + x] > 24) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  const out = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) data.copy(out, y * width, (y + y0) * info.width + x0, (y + y0) * info.width + x1 + 1);
  return { data: out, width, height };
}

function rgba(mask: { data: Buffer; width: number; height: number }): Buffer {
  const out = Buffer.alloc(mask.width * mask.height * 4);
  for (let i = 0; i < mask.width * mask.height; i++) {
    out[i * 4] = ORANGE.r; out[i * 4 + 1] = ORANGE.g; out[i * 4 + 2] = ORANGE.b; out[i * 4 + 3] = mask.data[i];
  }
  return out;
}

function dash(): Buffer {
  const alpha = [110, 255, 255, 255, 90]; // soft top and bottom rows
  const out = Buffer.alloc(DASH.length * DASH.height * 4);
  for (let y = 0; y < DASH.height; y++)
    for (let x = 0; x < DASH.length; x++) {
      const i = (y * DASH.length + x) * 4;
      out[i] = ORANGE.r; out[i + 1] = ORANGE.g; out[i + 2] = ORANGE.b; out[i + 3] = alpha[y];
    }
  return out;
}

async function main(): Promise<void> {
  // The old line was ~33 px of ink high in a lighter weight; Bold 30 matches it by eye. Shrink only if the words would not fit.
  let size = 30;
  let mask = await textMask(size);
  while (mask.width > MAX_TEXT_WIDTH && size > 20) mask = await textMask(--size);
  const textLeft = Math.round(CENTRE_X - mask.width / 2);
  const white = await sharp({ create: { width: STRIP.width, height: STRIP.height, channels: 4, background: "#ffffff" } }).png().toBuffer();
  const line = await sharp(rgba(mask), { raw: { width: mask.width, height: mask.height, channels: 4 } }).png().toBuffer();
  const bar = await sharp(dash(), { raw: { width: DASH.length, height: DASH.height, channels: 4 } }).png().toBuffer();

  for (const file of TEMPLATES) {
    const target = path.join(ASSETS, file);
    const out = await sharp(target)
      .composite([
        { input: white, left: STRIP.left, top: STRIP.top },
        { input: line, left: textLeft, top: TEXT_TOP },
        { input: bar, left: textLeft - DASH.gap - DASH.length, top: DASH.top },
        { input: bar, left: textLeft + mask.width + DASH.gap, top: DASH.top },
      ])
      .png({ compressionLevel: 9 })
      .toBuffer();
    await sharp(out).toFile(target);
    console.log(`${file}: "${TAGLINE}" (Poppins Bold ${size}, ${mask.width} x ${mask.height} px at x ${textLeft}, y ${TEXT_TOP})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
