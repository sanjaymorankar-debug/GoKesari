/**
 * docs/shop-welcome-kit-2026-11: rewrites the white line on the orange ribbon of a local-language shop-banner
 * template ("We are available on" on the English design). Owner's correction of 21-Nov-2026 for Marathi:
 * "आमचे दुकान आता ऑनलाइन" → "आपले दुकान आता ऑनलाइन".
 *
 * The old white letters are removed column by column: each letter pixel takes the ribbon colour interpolated
 * between the nearest ribbon pixels above and below it (the ribbon's shading runs top to bottom), then the filled
 * pixels are softened. The new line is drawn centred where the old one was, in white Poppins Bold at the old
 * line's height. Run on a template that has the line, then look at it and commit:
 *
 *     node --import tsx scripts/shop-banner/set-ribbon.ts mr
 *
 * make-local-templates.py has the same words in TEXTS; after re-running it this script is not needed.
 */
import path from "node:path";

import sharp from "sharp";

const ASSETS = path.join(process.cwd(), "src", "server", "shop-banner", "assets");
const FONT_FILE = path.join(ASSETS, "Poppins-Bold.ttf");
process.env.FONTCONFIG_FILE ??= path.join(ASSETS, "fonts.conf");
process.env.PANGOCAIRO_BACKEND ??= "fc";

export const RIBBON_TEXT: Record<string, string> = { mr: "आपले दुकान आता ऑनलाइन" };

// Pixel geometry of the 1536 x 1024 templates: the ribbon line's letters (measured on template-mr.png).
const AREA = { x0: 440, x1: 1110, y0: 308, y1: 382 }; // the old line incl. the ु under दु (GoKesari.com starts at y 384)
const LINE = { centreX: 775, inkTop: 312, inkHeight: 72, maxWidth: 655 }; // old line: x 447-1102, y 312-380
const isLetter = (r: number, g: number, b: number) => b > 70 || (r > 230 && g > 200); // the ribbon's orange has b < 40

async function main(): Promise<void> {
  const lang = process.argv[2] ?? "mr";
  const words = RIBBON_TEXT[lang];
  if (!words) throw new Error(`no ribbon text for ${lang}`);
  const target = path.join(ASSETS, `template-${lang}.png`);
  const { data, info } = await sharp(target).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const at = (x: number, y: number) => (y * W + x) * 3;

  // 1. The letters (and a 2-px margin for their soft edges).
  const mask = new Uint8Array(W * info.height);
  for (let y = AREA.y0; y <= AREA.y1; y++)
    for (let x = AREA.x0; x <= AREA.x1; x++) {
      const i = at(x, y);
      if (isLetter(data[i], data[i + 1], data[i + 2]))
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (y + dy <= AREA.y1) mask[(y + dy) * W + x + dx] = 1;
    }
  // 2. Fill each masked run from the ribbon above and below it.
  for (let x = AREA.x0 - 2; x <= AREA.x1 + 2; x++) {
    let y = AREA.y0;
    while (y <= AREA.y1) {
      if (!mask[y * W + x]) { y++; continue; }
      const start = y;
      while (y <= AREA.y1 && mask[y * W + x]) y++;
      const a = at(x, start - 1);
      // Below the old line the ribbon meets "GoKesari.com": anchor only on ribbon orange, else repeat the colour above.
      const b = y < info.height && data[at(x, y) + 2] < 45 ? at(x, y) : a;
      const n = y - start + 1;
      for (let k = 0; k < y - start; k++) {
        const t = (k + 1) / n, i = at(x, start + k);
        for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[a + c] * (1 - t) + data[b + c] * t);
      }
    }
  }
  // 3. Soften the filled pixels (3x3 average, twice) so no letter shapes show.
  for (let pass = 0; pass < 2; pass++) {
    const copy = Buffer.from(data);
    for (let y = AREA.y0; y <= AREA.y1; y++)
      for (let x = AREA.x0 - 2; x <= AREA.x1 + 2; x++) {
        if (!mask[y * W + x]) continue;
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += copy[at(x + dx, y + dy) + c];
          data[at(x, y) + c] = Math.round(s / 9);
        }
      }
  }

  // 4. The new line: white Poppins Bold, the old line's ink height, centred where it was.
  let size = 60, line = { png: Buffer.alloc(0), width: 0, height: 0, top: 0 };
  for (; size > 20; size--) {
    const { data: ink, info: li } = await sharp({ text: { text: words, font: `Poppins Bold ${size}`, fontfile: FONT_FILE, dpi: 72 } })
      .extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    let top = li.height, bottom = -1;
    for (let yy = 0; yy < li.height; yy++) for (let xx = 0; xx < li.width; xx++) if (ink[yy * li.width + xx] > 24) { top = Math.min(top, yy); bottom = Math.max(bottom, yy); }
    if (bottom - top + 1 > LINE.inkHeight || li.width > LINE.maxWidth) continue;
    const rgba = Buffer.alloc(li.width * li.height * 4, 255);
    for (let k = 0; k < li.width * li.height; k++) rgba[k * 4 + 3] = ink[k];
    line = { png: await sharp(rgba, { raw: { width: li.width, height: li.height, channels: 4 } }).png().toBuffer(), width: li.width, height: li.height, top };
    break;
  }
  const base = await sharp(data, { raw: { width: W, height: info.height, channels: 3 } }).png().toBuffer();
  const out = await sharp(base)
    .composite([{ input: line.png, left: Math.round(LINE.centreX - line.width / 2), top: LINE.inkTop - line.top }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await sharp(out).toFile(target);
  console.log(`template-${lang}.png: ribbon "${words}" (Poppins Bold ${size}, ${line.width} px wide)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
