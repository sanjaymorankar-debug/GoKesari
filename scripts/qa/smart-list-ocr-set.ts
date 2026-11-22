/**
 * Builds the SYNTHETIC part of the photo-shopping-list OCR test set (docs/smart-shopping-2026-11): 20 list
 * images rendered from system fonts — printed Marathi, Hindi, English, Gujarati and mixed lists, plus
 * blurry, dark, rotated and bill samples — with the expected items. Real handwritten photos come from the
 * owner (put them in the same folder with an entry in expected.json); synthetic images are labelled as such
 * in every report.
 *
 *   npx tsx scripts/qa/smart-list-ocr-set.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import sharp from "sharp";

const OUT = path.resolve("tests/fixtures/smart-list-ocr");
type Item = { nameEn: string; amount: number; unit: "g" | "ml" | "piece" | "pack" };
type Case = { file: string; lang: string; kind: string; lines: string[]; items: Item[]; effect?: "blur" | "dark" | "rotate" | "heavy-blur"; expectUnreadable?: boolean; font?: string };

const DEV = "Kohinoor Devanagari, Devanagari Sangam MN";
const GUJ = "Gujarati Sangam MN";
const LAT = "Bradley Hand, Noteworthy, Marker Felt";

const mr1: Item[] = [
  { nameEn: "Milk", amount: 2000, unit: "ml" },
  { nameEn: "Sugar", amount: 1000, unit: "g" },
  { nameEn: "Rice", amount: 5000, unit: "g" },
  { nameEn: "Wheat", amount: 2000, unit: "g" },
  { nameEn: "Cooking oil", amount: 1000, unit: "ml" },
  { nameEn: "Soap", amount: 4, unit: "piece" },
];
const CASES: Case[] = [
  { file: "01-mr-printed.png", lang: "mr", kind: "printed", lines: ["दूध २ लिटर", "साखर १ किलो", "तांदूळ ५ किलो", "गहू २ किलो", "तेल १ लिटर", "साबण ४ नग"], items: mr1, font: DEV },
  { file: "02-hi-printed.png", lang: "hi", kind: "printed", lines: ["दूध २ लीटर", "चीनी १ किलो", "चावल ५ किलो", "गेहूं २ किलो", "तेल १ लीटर"], items: mr1.slice(0, 5), font: DEV },
  { file: "03-en-handwriting-font.png", lang: "en", kind: "script-font", lines: ["Milk 2 litres", "Sugar 1 kg", "Rice 5 kg", "Wheat 2 kg", "Cooking oil 1 litre"], items: mr1.slice(0, 5), font: LAT },
  { file: "04-gu-printed.png", lang: "gu", kind: "printed", lines: ["દૂધ ૨ લિટર", "ખાંડ ૧ કિલો", "ચોખા ૫ કિલો"], items: mr1.slice(0, 3), font: GUJ },
  { file: "05-mixed-mr-en.png", lang: "mr+en", kind: "printed", lines: ["Amul butter 500 gm", "पोहे १ किलो", "Parle-G 2 packet", "कांदा २ किलो", "अंडी १ डझन"], items: [{ nameEn: "Butter", amount: 500, unit: "g" }, { nameEn: "Poha", amount: 1000, unit: "g" }, { nameEn: "Biscuits", amount: 2, unit: "pack" }, { nameEn: "Onion", amount: 2000, unit: "g" }, { nameEn: "Eggs", amount: 12, unit: "piece" }], font: DEV },
  { file: "06-mr-fractions.png", lang: "mr", kind: "printed", lines: ["अर्धा किलो तूप", "पाव किलो जिरे", "दीड लिटर दूध", "तूरडाळ २ किलो"], items: [{ nameEn: "Ghee", amount: 500, unit: "g" }, { nameEn: "Cumin", amount: 250, unit: "g" }, { nameEn: "Milk", amount: 1500, unit: "ml" }, { nameEn: "Toor dal", amount: 2000, unit: "g" }], font: DEV },
  { file: "07-hi-words.png", lang: "hi", kind: "printed", lines: ["आधा किलो चाय पत्ती", "डेढ़ किलो आटा", "बारह अंडे", "दो साबुन"], items: [{ nameEn: "Tea", amount: 500, unit: "g" }, { nameEn: "Wheat flour", amount: 1500, unit: "g" }, { nameEn: "Eggs", amount: 12, unit: "piece" }, { nameEn: "Soap", amount: 2, unit: "piece" }], font: DEV },
  { file: "08-mr-blurry.png", lang: "mr", kind: "printed-blur", lines: ["दूध २ लिटर", "साखर १ किलो", "तांदूळ ५ किलो"], items: mr1.slice(0, 3), effect: "blur", font: DEV },
  { file: "09-mr-dark.png", lang: "mr", kind: "printed-lowlight", lines: ["दूध २ लिटर", "साखर १ किलो", "तांदूळ ५ किलो"], items: mr1.slice(0, 3), effect: "dark", font: DEV },
  { file: "10-en-rotated.png", lang: "en", kind: "printed-rotated", lines: ["Bread 1", "Eggs 12", "Butter 500 g", "Milk 1 L"], items: [{ nameEn: "Bread", amount: 1, unit: "piece" }, { nameEn: "Eggs", amount: 12, unit: "piece" }, { nameEn: "Butter", amount: 500, unit: "g" }, { nameEn: "Milk", amount: 1000, unit: "ml" }], effect: "rotate", font: LAT },
  { file: "11-unreadable.png", lang: "mr", kind: "unreadable", lines: ["दूध २ लिटर", "साखर १ किलो"], items: [], effect: "heavy-blur", expectUnreadable: true, font: DEV },
  { file: "12-bill.png", lang: "en", kind: "bill", lines: ["SHREE KIRANA  Bill No 2231", "Sugar 1 kg      45.00", "Tea 250 g      120.00", "Toor dal 1 kg  160.00", "TOTAL          325.00"], items: [{ nameEn: "Sugar", amount: 1000, unit: "g" }, { nameEn: "Tea", amount: 250, unit: "g" }, { nameEn: "Toor dal", amount: 1000, unit: "g" }], font: "Menlo" },
  { file: "13-mr-long.png", lang: "mr", kind: "printed", lines: ["दूध २ लिटर", "साखर १ किलो", "तांदूळ ५ किलो", "गहू २ किलो", "तेल १ लिटर", "साबण ४ नग", "पोहे १ किलो", "कांदा २ किलो", "बटाटा ३ किलो", "मीठ १ पाकीट"], items: [...mr1, { nameEn: "Poha", amount: 1000, unit: "g" }, { nameEn: "Onion", amount: 2000, unit: "g" }, { nameEn: "Potato", amount: 3000, unit: "g" }, { nameEn: "Salt", amount: 1, unit: "pack" }], font: DEV },
  { file: "14-hi-mixed-en.png", lang: "hi+en", kind: "printed", lines: ["Surf Excel 1 kg", "टूथपेस्ट २", "Maggi 4 packet", "दही ५०० ग्राम"], items: [{ nameEn: "Detergent", amount: 1000, unit: "g" }, { nameEn: "Toothpaste", amount: 2, unit: "piece" }, { nameEn: "Noodles", amount: 4, unit: "pack" }, { nameEn: "Curd", amount: 500, unit: "g" }], font: DEV },
  { file: "15-en-printed.png", lang: "en", kind: "printed", lines: ["Sunflower oil 1 L", "Basmati rice 5 kg", "Atta 10 kg", "Salt 1 kg"], items: [{ nameEn: "Cooking oil", amount: 1000, unit: "ml" }, { nameEn: "Rice", amount: 5000, unit: "g" }, { nameEn: "Wheat flour", amount: 10000, unit: "g" }, { nameEn: "Salt", amount: 1000, unit: "g" }], font: "Helvetica" },
  { file: "16-gu-mixed.png", lang: "gu+en", kind: "printed", lines: ["ખાંડ ૨ કિલો", "Tea 250 g", "દૂધ ૧ લિટર"], items: [{ nameEn: "Sugar", amount: 2000, unit: "g" }, { nameEn: "Tea", amount: 250, unit: "g" }, { nameEn: "Milk", amount: 1000, unit: "ml" }], font: GUJ },
  { file: "17-mr-dark-blur.png", lang: "mr", kind: "printed-lowlight-blur", lines: ["तेल १ लिटर", "साबण ४ नग", "पोहे १ किलो"], items: [{ nameEn: "Cooking oil", amount: 1000, unit: "ml" }, { nameEn: "Soap", amount: 4, unit: "piece" }, { nameEn: "Poha", amount: 1000, unit: "g" }], effect: "dark", font: DEV },
  { file: "18-hi-numbers-words.png", lang: "hi", kind: "printed", lines: ["पांच किलो चावल", "दो लीटर दूध", "एक दर्जन केले"], items: [{ nameEn: "Rice", amount: 5000, unit: "g" }, { nameEn: "Milk", amount: 2000, unit: "ml" }, { nameEn: "Banana", amount: 12, unit: "piece" }], font: DEV },
  { file: "19-mr-brands.png", lang: "mr", kind: "printed", lines: ["अमूल दूध २ लिटर", "टाटा मीठ १ पाकीट", "पार्ले जी ३ पाकीट"], items: [{ nameEn: "Milk", amount: 2000, unit: "ml" }, { nameEn: "Salt", amount: 1, unit: "pack" }, { nameEn: "Biscuits", amount: 3, unit: "pack" }], font: DEV },
  { file: "20-en-script-rotated.png", lang: "en", kind: "script-font-rotated", lines: ["Tomato 1 kg", "Onion 2 kg", "Potato 3 kg"], items: [{ nameEn: "Tomato", amount: 1000, unit: "g" }, { nameEn: "Onion", amount: 2000, unit: "g" }, { nameEn: "Potato", amount: 3000, unit: "g" }], effect: "rotate", font: LAT },
];

function svg(c: Case): string {
  const h = 120 + c.lines.length * 70;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const rows = c.lines.map((l, i) => `<text x="40" y="${110 + i * 70}" font-family="${c.font}" font-size="42" fill="#1b2a4a" transform="rotate(${(i % 3) - 1} 40 ${110 + i * 70})">${esc(l)}</text>`).join("");
  const rules = c.lines.map((_, i) => `<line x1="20" x2="780" y1="${122 + i * 70}" y2="${122 + i * 70}" stroke="#a9c4e8" stroke-width="2"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="${h}"><rect width="100%" height="100%" fill="#fbf7ea"/>${rules}${rows}</svg>`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const c of CASES) {
    let img = sharp(Buffer.from(svg(c))).flatten({ background: "#fbf7ea" });
    if (c.effect === "blur") img = img.blur(2.2);
    if (c.effect === "heavy-blur") img = img.blur(14);
    if (c.effect === "dark") img = img.modulate({ brightness: 0.28 }).blur(c.kind.includes("blur") ? 1.5 : 0.3);
    if (c.effect === "rotate") img = img.rotate(90, { background: "#fbf7ea" });
    await img.jpeg({ quality: 80 }).toFile(path.join(OUT, c.file.replace(/\.png$/, ".jpg")));
  }
  writeFileSync(
    path.join(OUT, "expected.json"),
    JSON.stringify(
      CASES.map(({ file, lang, kind, items, expectUnreadable }) => ({ file: file.replace(/\.png$/, ".jpg"), synthetic: true, lang, kind, items, expectUnreadable: Boolean(expectUnreadable) })),
      null,
      2,
    ) + "\n",
  );
  console.log(`${CASES.length} synthetic list images written to ${OUT}`);
}

void main();
