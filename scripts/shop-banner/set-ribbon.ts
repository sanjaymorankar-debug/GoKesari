/**
 * docs/shop-welcome-kit-2026-11: rewrites the white line on the orange ribbon of a local-language shop-banner
 * template ("We are available on" on the English design). Owner's correction of 21-Nov-2026 for Marathi:
 * "आमचे दुकान आता ऑनलाइन" → "आपले दुकान आता ऑनलाइन". Owner brief of 26-Nov-2026: the headline on every
 * template is "This shop is now live on GoKesari.com" (Marathi / Hindi below, to be checked by a native speaker).
 *
 * The old white letters are removed column by column: each letter pixel takes the ribbon colour interpolated
 * between the nearest ribbon pixels above and below it (the ribbon's shading runs top to bottom), then the filled
 * pixels are softened. The new line is drawn centred where the old one was, in white Poppins Bold at the old
 * line's height. Run on a template that has the line, then look at it and commit:
 *
 *     node --import tsx scripts/shop-banner/set-ribbon.ts en   (and mr, hi)
 *
 * make-local-templates.py has the same words in TEXTS; after re-running it this script is not needed.
 */
import path from "node:path";

import sharp from "sharp";

const ASSETS = path.join(process.cwd(), "src", "server", "shop-banner", "assets");
const FONT_FILE = path.join(ASSETS, "Poppins-Bold.ttf");
process.env.FONTCONFIG_FILE ??= path.join(ASSETS, "fonts.conf");
process.env.PANGOCAIRO_BACKEND ??= "fc";

export const RIBBON_TEXT: Record<string, string> = {
  en: "This shop is now live on",
  mr: "हे दुकान आता लाइव्ह आहे",
  hi: "यह दुकान अब लाइव है",
};

// Pixel geometry of the 1536 x 1024 templates: the ribbon line's letters (measured 21-Nov on template-mr.png and
// 26-Nov on template.png / template-hi.png). AREA holds the old line (incl. a ु under दु; GoKesari.com starts at
// y 383, its K at y 377); LINE is where the new one goes: Devanagari gets the taller box of the old Marathi line.
const GEOMETRY: Record<string, { area: { x0: number; x1: number; y0: number; y1: number }; line: { centreX: number; inkTop: number; inkHeight: number; maxWidth: number } }> = {
  en: { area: { x0: 403, x1: 1141, y0: 314, y1: 372 }, line: { centreX: 772, inkTop: 318, inkHeight: 53, maxWidth: 720 } },
  mr: { area: { x0: 440, x1: 1110, y0: 308, y1: 382 }, line: { centreX: 775, inkTop: 312, inkHeight: 66, maxWidth: 680 } },
  hi: { area: { x0: 458, x1: 1088, y0: 308, y1: 382 }, line: { centreX: 772, inkTop: 312, inkHeight: 66, maxWidth: 680 } },
};
const isLetter = (r: number, g: number, b: number) => b > 70 || (r > 230 && g > 200); // the ribbon's orange has b < 40

async function main(): Promise<void> {
  const lang = process.argv[2] ?? "mr";
  const words = RIBBON_TEXT[lang];
  if (!words) throw new Error(`no ribbon text for ${lang}`);
  const { area: AREA, line: LINE } = GEOMETRY[lang];
  const target = path.join(ASSETS, lang === "en" ? "template.png" : `template-${lang}.png`);
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
  // 2b. English (26-Nov): the old line is much wider than the new one, so its whole box is repainted as a
  // top-to-bottom blend of the ribbon just above and below it. The two anchor rows carry the old letters' soft
  // shadow, so each is first averaged over ±40 px across.
  if (lang === "en") {
    const anchor = (y: number) => {
      const row: number[][] = [];
      for (let x = AREA.x0; x <= AREA.x1; x++) {
        const sum = [0, 0, 0];
        let n = 0;
        for (let k = x - 40; k <= x + 40; k++, n++) for (let c = 0; c < 3; c++) sum[c] += data[at(k, y) + c];
        row.push(sum.map((v) => v / n));
      }
      return row;
    };
    const top = anchor(AREA.y0 - 2), bottom = anchor(AREA.y1 + 2), n = AREA.y1 - AREA.y0 + 4;
    for (let x = AREA.x0; x <= AREA.x1; x++) {
      for (let y = AREA.y0 - 1; y <= AREA.y1 + 1; y++) {
        const t = (y - AREA.y0 + 2) / n, i = at(x, y);
        for (let c = 0; c < 3; c++) data[i + c] = Math.round(top[x - AREA.x0][c] * (1 - t) + bottom[x - AREA.x0][c] * t);
        mask[y * W + x] = 1;
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
  console.log(`${path.basename(target)}: ribbon "${words}" (Poppins Bold ${size}, ${line.width} px wide)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
