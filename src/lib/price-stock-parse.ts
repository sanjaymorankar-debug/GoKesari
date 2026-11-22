/**
 * Price, stock and selling unit from what a shop owner says or types
 * (docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md): "₹60 per litre, 50 bottles",
 * "₹40 per nug, 100", "120 रुपये किलो, 20 किलो", "साठ रुपये लिटर पन्नास बाटल्या".
 *
 * Deterministic and client-safe: the browser reads the owner's sentence straight away, and the
 * server asks AI (VOICE_PARSE) only when this parse is incomplete. Built on lib/qty-words (regional
 * digits, Marathi/Hindi number words, unit words) with the extra number words and inflected unit
 * words that price talk needs ("एकशे", "दीडशे", "अस्सी", "बाटल्या", "लिटरला").
 *
 * Selling units and how they map to the catalogue's products.unit (piece, pack, dozen, kg, g, L, ml):
 *   piece/nug → piece · kg → kg · g → g · litre → L · ml → ml · dozen → dozen · packet → pack
 *   box → pack (a sealed box is one pack; the word "box" is kept in the listing's details)
 *   metre → piece, one piece = one metre (the catalogue has no length unit; the word is kept)
 *   custom ("जुडी", "bundle") → piece, one piece = one of that unit (the word is kept)
 */
import { asciiDigits, numberFromWord, unitFromWord, type BaseUnit } from "./qty-words";
import type { ProductUnit } from "./product-units";

export const SELLING_UNITS = ["piece", "kg", "g", "litre", "ml", "dozen", "packet", "box", "metre", "custom"] as const;
export type SellingUnit = (typeof SELLING_UNITS)[number];

export interface PriceStock {
  /** Price in paise for one `priceUnit`; null when not said. */
  pricePaise: number | null;
  priceUnit: SellingUnit | null;
  /** Number of `stockUnit`s in stock; null when not said. */
  stock: number | null;
  stockUnit: SellingUnit | null;
  /** The owner's own word for a custom unit ("जुडी"). */
  customUnit: string | null;
  /** The word the stock was counted in ("bottles", "बाटल्या"), for the read-back. */
  stockWord: string | null;
}

export interface PriceStockParse extends PriceStock {
  /** Both a price and a stock figure were found. */
  complete: boolean;
  missing: ("price" | "stock")[];
}

/* ------------------------------------------------------------ vocabulary */

/** Number words qty-words does not carry: Hindi/Marathi tens and teens, English teens. */
const EXTRA_NUMBERS: Record<string, number> = {
  thirteen: 13, fourteen: 14, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, thousand: 1000,
  // Hindi
  तेरह: 13, चौदह: 14, सोलह: 16, सत्रह: 17, अठारह: 18, उन्नीस: 19, इक्कीस: 21, बाईस: 22, तेईस: 23, चौबीस: 24,
  पैंतीस: 35, पैंतालीस: 45, पचपन: 55, पैंसठ: 65, पचहत्तर: 75, अस्सी: 80, पचासी: 85, नब्बे: 90, पंचानवे: 95,
  // Marathi
  एकवीस: 21, बावीस: 22, तेवीस: 23, चोवीस: 24, अठ्ठावीस: 28, पस्तीस: 35, पंचेचाळीस: 45, पंचावन्न: 55, पासष्ट: 65,
  पंचाहत्तर: 75, पंच्याऐंशी: 85, पंच्याण्णव: 95, साठ: 60,
};

/** Marathi hundreds written as one word: एकशे 100, दोनशे 200, दीडशे 150, अडीचशे 250, सव्वाशे 125. */
const MARATHI_HUNDREDS: Record<string, number> = { दीडशे: 150, अडीचशे: 250, सव्वाशे: 125, शंभर: 100 };

const RUPEE_WORDS = new Set([
  "₹", "rs", "rs.", "inr", "rupee", "rupees", "rupaye", "rupay", "rupiya", "रुपये", "रुपए", "रुपया", "रुपय", "रु", "रू", "रु.",
  "रुपयांना", "रुपयाला", "रुपयात", "रुपयांत", "रुपयाचे", "रुपयांचे", "रुपयाची", "रुपयांची", "रुपयाचा", "रुपयांचा", "रुपयेच",
]);
const PER_WORDS = new Set(["per", "a", "an", "each", "every", "प्रति", "प्रत्येकी", "दर", "पर", "का", "की", "के"]);
const STOCK_WORDS = new Set(["stock", "qty", "quantity", "स्टॉक", "साठा", "माल", "शिल्लक", "नग:"]);
const FILLER = new Set(["and", "और", "आणि", "व", "है", "हैं", "आहे", "आहेत", "is", "are", "of", "the", "rate", "price", "किंमत", "कीमत", "भाव", "दाम", "mrp"]);

/** Inflected and plural unit words qty-words does not carry, to a selling unit. */
const EXTRA_UNITS: Record<string, SellingUnit> = {
  unit: "piece", units: "piece", each: "piece", nugs: "piece", nags: "piece", नगं: "piece", नगे: "piece", बाटल्या: "piece",
  बाटली: "piece", बाटल्यां: "piece", बोतलें: "piece", बोतले: "piece", बॉटल: "piece", बॉटल्स: "piece", पीसेस: "piece",
  "pcs.": "piece", tins: "piece", tin: "piece", jar: "piece", jars: "piece", can: "piece", cans: "piece",
  किलोग्राम: "kg", किलोग्रॅम: "kg", "किग्रॅ": "kg", kgs: "kg",
  ग्रॅ: "g", "ग्रॅ.": "g", ग्राम्स: "g", grm: "g",
  ली: "litre", "ली.": "litre", लि: "litre", "लि.": "litre", लिटर्स: "litre", ltrs: "litre",
  "मि.ली.": "ml", मिलि: "ml", "मि.ली": "ml", मिलीलीटर: "ml", मिलीलिटर: "ml",
  डझनं: "dozen", dozens: "dozen", दर्जनों: "dozen",
  पाकिटे: "packet", पाकिटं: "packet", पाकीटं: "packet", पॅकेट्स: "packet", पैकेट्स: "packet", पुडे: "packet", पुड्या: "packet",
  pouch: "packet", pouches: "packet", sachet: "packet", sachets: "packet",
  डबे: "box", डब्बे: "box", डिब्बे: "box", बॉक्सेस: "box", carton: "box", cartons: "box", खोकी: "box", खोका: "box",
  mtr: "metre", mtrs: "metre", meters: "metre", मीटर्स: "metre", मिटर: "metre",
};

/** Marathi/Hindi case endings on a unit word: "लिटरला", "किलोचा", "नगाला", "किलोके". */
const UNIT_SUFFIXES = ["ाला", "ला", "चा", "ची", "चे", "ाचे", "ने", "के", "का", "की"];

function sellingUnitFromBase(unit: BaseUnit, factor: number): SellingUnit {
  switch (unit) {
    case "g":
      return factor >= 1000 ? "kg" : "g";
    case "ml":
      return factor >= 1000 ? "litre" : "ml";
    case "piece":
      return factor === 12 ? "dozen" : "piece";
    case "pack":
      return "packet";
    case "box":
      return "box";
    case "m":
      return "metre";
  }
}

/** A unit word (any inflection we know) → selling unit, or null. */
export function sellingUnitFromWord(word: string): SellingUnit | null {
  const w = word.trim().toLowerCase().replace(/[,;:।]+$/, "").replace(/(?<=[\p{L}\p{M}])\.$/u, "");
  if (!w || /^\d/.test(w)) return null;
  const direct = (w: string): SellingUnit | null => {
    if (EXTRA_UNITS[w]) return EXTRA_UNITS[w];
    const base = unitFromWord(w);
    return base ? sellingUnitFromBase(base.unit, base.factor) : null;
  };
  const hit = direct(w);
  if (hit) return hit;
  for (const suffix of UNIT_SUFFIXES) {
    if (w.length > suffix.length + 1 && w.endsWith(suffix)) {
      const stem = direct(w.slice(0, -suffix.length));
      if (stem) return stem;
    }
  }
  return null;
}

/* ------------------------------------------------------------ tokens */

function tokenize(text: string): string[] {
  let s = asciiDigits(text).toLowerCase();
  // Indian and western thousands separators inside a number: 1,200 · 1,20,000.
  for (let i = 0; i < 3; i++) s = s.replace(/(\d),(\d{2,3})(?!\d)/g, "$1$2");
  s = s
    .replace(/\/-/g, " ")
    .replace(/₹/g, " ₹ ")
    .replace(/\brs\.?(?=\s|\d|$)/g, " ₹ ")
    .replace(/\//g, " per ")
    .replace(/[,;।|]+/g, " , ")
    .replace(/(\d)([^\d\s.,])/gu, "$1 $2") // "60rs" → "60 rs", "2kg" → "2 kg"
    .replace(/([^\d\s.,₹-])(\d)/gu, "$1 $2"); // "₹60" handled above; "kg2" → "kg 2"
  // "60." at the end of a sentence is 60.
  return s
    .split(/\s+/)
    .map((t) => (/\d\.$/.test(t) ? t.slice(0, -1) : t))
    .filter(Boolean);
}

function wordNumber(token: string): number | null {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  if (MARATHI_HUNDREDS[token] !== undefined) return MARATHI_HUNDREDS[token];
  if (token.length > 2 && token.endsWith("शे")) {
    const head = token.slice(0, -2);
    const n = EXTRA_NUMBERS[head] ?? numberFromWord(head);
    if (n !== null && n >= 1 && n <= 9) return n * 100;
  }
  if (EXTRA_NUMBERS[token] !== undefined) return EXTRA_NUMBERS[token];
  return numberFromWord(token);
}

const isDigits = (t: string) => /^\d+(\.\d+)?$/.test(t);

/**
 * Reads one number starting at `i`: "60", "साठ", "एकशे वीस" (120), "एक सौ बीस" (120),
 * "one hundred and twenty", "forty five". Digits never join the next token except a
 * hundred/thousand word, so "60 50" stays two numbers.
 */
function readNumber(tokens: string[], i: number): { value: number; end: number } | null {
  let total = 0;
  let current: number | null = null;
  let j = i;
  let lastWasDigits = false;
  while (j < tokens.length) {
    const t = tokens[j];
    if (current !== null && (t === "and" || t === "आणि" || t === "और") && j + 1 < tokens.length) {
      const next = wordNumber(tokens[j + 1]);
      if (next !== null && next < 100 && !isDigits(tokens[j + 1]) && current >= 100) {
        j++;
        continue;
      }
      break;
    }
    if (sellingUnitFromWord(t) && current !== null) break; // "10 dozen": dozen is the unit, not 12
    const v = wordNumber(t);
    if (v === null) break;
    const digits = isDigits(t);
    if (current === null) {
      current = v;
    } else if (v === 100 || v === 1000) {
      current = current * v;
      if (v === 1000) {
        total += current;
        current = 0;
      }
    } else if (lastWasDigits || digits) {
      break;
    } else if (current >= 100 && current % 100 === 0 && v < 100) {
      current += v;
    } else if (current >= 20 && current < 100 && current % 10 === 0 && v < 10) {
      current += v;
    } else {
      break;
    }
    lastWasDigits = digits;
    j++;
  }
  if (current === null) return null;
  return { value: total + current, end: j };
}

interface NumberAt {
  value: number;
  start: number;
  end: number;
}

function numbersIn(tokens: string[]): NumberAt[] {
  const out: NumberAt[] = [];
  let i = 0;
  while (i < tokens.length) {
    // A bare unit word that is also a number word ("dozen", "पाव") is a unit here.
    if (sellingUnitFromWord(tokens[i]) && !isDigits(tokens[i])) {
      i++;
      continue;
    }
    const n = readNumber(tokens, i);
    if (n) {
      out.push({ value: n.value, start: i, end: n.end });
      i = n.end;
    } else i++;
  }
  return out;
}

/* ------------------------------------------------------------ parse */

interface UnitAt {
  unit: SellingUnit | null;
  custom: string | null;
  word: string | null;
  end: number;
  perSeen: boolean;
}

/** The unit after a number: skips rupee words, "per", fillers; an unknown word right after "per" is a custom unit. */
function unitAfter(tokens: string[], from: number, allowCustom: boolean): UnitAt {
  let j = from;
  let perSeen = false;
  while (j < tokens.length && (RUPEE_WORDS.has(tokens[j]) || PER_WORDS.has(tokens[j]) || FILLER.has(tokens[j]))) {
    if (PER_WORDS.has(tokens[j])) {
      perSeen = true;
      if (tokens[j] === "each" || tokens[j] === "every") return { unit: "piece", custom: null, word: tokens[j], end: j + 1, perSeen };
    }
    j++;
  }
  // "एक लिटर" / "one kg" after per: a 1 in front of the unit.
  if (j < tokens.length && (tokens[j] === "एक" || tokens[j] === "one" || tokens[j] === "1") && j + 1 < tokens.length && sellingUnitFromWord(tokens[j + 1])) j++;
  const t = tokens[j];
  if (t === undefined || t === ",") return { unit: null, custom: null, word: null, end: j, perSeen };
  const unit = sellingUnitFromWord(t);
  if (unit) return { unit, custom: null, word: t, end: j + 1, perSeen };
  if (allowCustom && perSeen && wordNumber(t) === null && !STOCK_WORDS.has(t) && /\p{L}/u.test(t)) {
    return { unit: "custom", custom: t, word: t, end: j + 1, perSeen };
  }
  return { unit: null, custom: null, word: null, end: j, perSeen };
}

function hasRupeeBefore(tokens: string[], start: number): boolean {
  for (let k = start - 1; k >= 0 && k >= start - 2; k--) {
    if (RUPEE_WORDS.has(tokens[k])) return true;
    if (!FILLER.has(tokens[k])) return false;
  }
  return false;
}

function hasRupeeAfter(tokens: string[], end: number): boolean {
  return end < tokens.length && RUPEE_WORDS.has(tokens[end]);
}

function stockWordBefore(tokens: string[], start: number): boolean {
  for (let k = start - 1; k >= 0 && k >= start - 2; k--) {
    if (STOCK_WORDS.has(tokens[k])) return true;
    if (!FILLER.has(tokens[k]) && tokens[k] !== ",") return false;
  }
  return false;
}

/** The owner's sentence → price, stock and units. Missing parts are null and listed in `missing`. */
export function parsePriceStock(text: string): PriceStockParse {
  const tokens = tokenize(text ?? "");
  const numbers = numbersIn(tokens);
  let priceAt: NumberAt | null = null;
  // 1. A number with ₹ before or a rupee word after it is the price.
  priceAt = numbers.find((n) => hasRupeeBefore(tokens, n.start) || hasRupeeAfter(tokens, n.end)) ?? null;
  // 2. Else a number followed by "per" / "/".
  if (!priceAt) priceAt = numbers.find((n) => n.end < tokens.length && PER_WORDS.has(tokens[n.end]) && tokens[n.end] !== "a") ?? null;
  // 3. Else, with two numbers and no stock word in front of the first, the first is the price.
  if (!priceAt && numbers.length >= 2) priceAt = stockWordBefore(tokens, numbers[0].start) ? numbers[1] : numbers[0];
  if (!priceAt && numbers.length === 1 && !stockWordBefore(tokens, numbers[0].start)) {
    // One number alone: a price only when a "per <unit>" follows it.
    const u = unitAfter(tokens, numbers[0].end, true);
    if (u.perSeen && u.unit) priceAt = numbers[0];
  }

  let pricePaise: number | null = null;
  let priceUnit: SellingUnit | null = null;
  let customUnit: string | null = null;
  let afterPrice = 0;
  if (priceAt) {
    pricePaise = Math.round(priceAt.value * 100);
    const u = unitAfter(tokens, priceAt.end, true);
    priceUnit = u.unit;
    customUnit = u.custom;
    afterPrice = u.unit ? u.end : priceAt.end;
  }

  // Stock: the first other number (after the price's unit, else anywhere else).
  const others = numbers.filter((n) => n !== priceAt && (priceAt === null || n.start >= afterPrice || n.end <= priceAt.start));
  const stockAt = others.find((n) => n.start >= afterPrice) ?? others[0] ?? null;
  let stock: number | null = null;
  let stockUnit: SellingUnit | null = null;
  let stockWord: string | null = null;
  if (stockAt) {
    stock = stockAt.value;
    const u = unitAfter(tokens, stockAt.end, false);
    if (u.unit) {
      stockUnit = u.unit;
      stockWord = u.word;
    } else if (u.end < tokens.length && customUnit && tokens[u.end] === customUnit) {
      stockUnit = "custom";
      stockWord = customUnit;
    } else {
      stockUnit = priceUnit;
      stockWord = null;
    }
  }
  if (stock !== null && !stockUnit) stockUnit = "piece";
  if (pricePaise !== null && !priceUnit && stockUnit) priceUnit = stockUnit === "custom" ? "custom" : stockUnit;

  const missing: ("price" | "stock")[] = [];
  if (pricePaise === null) missing.push("price");
  if (stock === null) missing.push("stock");
  return { pricePaise, priceUnit, stock, stockUnit, customUnit, stockWord, complete: missing.length === 0, missing };
}

/* ------------------------------------------------------------ read-back */

export type ParseLang = "en" | "hi" | "mr";

const UNIT_LABELS: Record<Exclude<SellingUnit, "custom">, Record<ParseLang, string>> = {
  piece: { en: "piece", hi: "पीस", mr: "नग" },
  kg: { en: "kg", hi: "किलो", mr: "किलो" },
  g: { en: "g", hi: "ग्राम", mr: "ग्रॅम" },
  litre: { en: "litre", hi: "लीटर", mr: "लिटर" },
  ml: { en: "ml", hi: "मि.ली.", mr: "मि.ली." },
  dozen: { en: "dozen", hi: "दर्जन", mr: "डझन" },
  packet: { en: "packet", hi: "पैकेट", mr: "पाकीट" },
  box: { en: "box", hi: "डिब्बा", mr: "डबा" },
  metre: { en: "metre", hi: "मीटर", mr: "मीटर" },
};

export function unitLabel(unit: SellingUnit, lang: ParseLang, custom?: string | null): string {
  if (unit === "custom") return custom?.trim() || { en: "unit", hi: "यूनिट", mr: "युनिट" }[lang];
  return UNIT_LABELS[unit][lang];
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const qty = (n: number) => String(Math.round(n * 1000) / 1000);

/** "Price ₹60 per litre, stock 50 bottles" in the owner's language, for the screen and speechSynthesis. */
export function readBack(p: PriceStock, lang: ParseLang): string {
  const parts: string[] = [];
  const word = { en: { price: "Price", per: "per", stock: "stock", none: "No price", noStock: "stock not given" }, hi: { price: "कीमत", per: "प्रति", stock: "स्टॉक", none: "कीमत नहीं", noStock: "स्टॉक नहीं बताया" }, mr: { price: "किंमत", per: "प्रति", stock: "साठा", none: "किंमत नाही", noStock: "साठा सांगितला नाही" } }[lang];
  parts.push(p.pricePaise !== null ? `${word.price} ${rupees(p.pricePaise)}${p.priceUnit ? ` ${word.per} ${unitLabel(p.priceUnit, lang, p.customUnit)}` : ""}` : word.none);
  if (p.stock !== null) {
    const unitText = p.stockWord && lang === "en" ? p.stockWord : p.stockUnit ? unitLabel(p.stockUnit, lang, p.customUnit) : "";
    parts.push(`${word.stock} ${qty(p.stock)}${unitText ? ` ${unitText}` : ""}`);
  } else parts.push(word.noStock);
  return parts.join(", ");
}

/* ------------------------------------------------------------ to the catalogue */

type Dim = "g" | "ml" | "m" | "count";

const UNIT_BASE: Record<SellingUnit, { dim: Dim; factor: number }> = {
  kg: { dim: "g", factor: 1000 },
  g: { dim: "g", factor: 1 },
  litre: { dim: "ml", factor: 1000 },
  ml: { dim: "ml", factor: 1 },
  metre: { dim: "m", factor: 1 },
  piece: { dim: "count", factor: 1 },
  dozen: { dim: "count", factor: 12 },
  packet: { dim: "count", factor: 1 },
  box: { dim: "count", factor: 1 },
  custom: { dim: "count", factor: 1 },
};

/** The catalogue unit (products.unit) a selling unit is listed in — see the table at the top of this file. */
export function catalogueUnitFor(unit: SellingUnit): ProductUnit {
  switch (unit) {
    case "kg":
      return "kg";
    case "g":
      return "g";
    case "litre":
      return "L";
    case "ml":
      return "ml";
    case "dozen":
      return "dozen";
    case "packet":
    case "box":
      return "pack";
    default:
      return "piece";
  }
}

/** A pack size read from the label ("500", "g") as a selling unit, or null. */
export function packUnitFromLabel(unit: string | null | undefined): SellingUnit | null {
  if (!unit) return null;
  return sellingUnitFromWord(unit) ?? (unit.trim() === "L" ? "litre" : null);
}

export interface ListingQuantities {
  /** products.unit and unit_size_milli for a NEW product. */
  unit: ProductUnit;
  unitSizeMilli: number;
  /** Sold by weight/volume with no pack: products.kind LOOSE (stock may have 3 decimals). */
  loose: boolean;
  /** Price of one sellable unit (one pack, or one kg/L of loose goods). */
  pricePaise: number | null;
  /** Stock in sellable units. */
  stock: number | null;
  notes: string[];
}

/** A sellable unit already in the catalogue (a matched product): from lib/qty-words packInBase. */
export interface ExistingPack {
  amount: number;
  unit: BaseUnit;
}

const BASE_DIM: Record<BaseUnit, Dim> = { g: "g", ml: "ml", piece: "count", pack: "count", box: "count", m: "m" };

/**
 * What the owner said (price per X, stock in Y) plus the pack read from the label (or the matched product's
 * pack) → one sellable unit, its price and the stock in those units.
 *   ₹60 per litre, 50 bottles, 1 L bottle     → L 1000, ₹60, 50
 *   ₹60 per litre, 50 bottles, 500 ml bottle  → ml 500 000, ₹30, 50
 *   ₹120 per kg, 20 kg, loose                 → kg 1000, ₹120, 20 (loose)
 *   ₹40 per nug, 100                          → piece, ₹40, 100
 *   ₹50 per dozen, 10 dozen (eggs, per piece) → for an existing piece listing: ₹4.17, 120
 */
export function toListingQuantities(
  said: PriceStock,
  pack: { size: number | null; unit: SellingUnit | null },
  existing: ExistingPack | null = null,
): ListingQuantities {
  const notes: string[] = [];
  const priceUnit = said.priceUnit ?? said.stockUnit ?? "piece";
  const priceBase = UNIT_BASE[priceUnit];

  // The sellable unit: an existing listing's pack, else the label's pack when it is a measure that matches how
  // the price was said (or the price is per piece/packet), else the price's own unit (loose goods).
  let unit: ProductUnit;
  let unitSizeMilli = 1000;
  let sell: { dim: Dim; amount: number };
  let loose = false;
  if (existing) {
    unit = "piece";
    sell = { dim: BASE_DIM[existing.unit], amount: existing.amount };
  } else if (pack.size && pack.size > 0 && pack.unit && UNIT_BASE[pack.unit].dim !== "count" && (UNIT_BASE[pack.unit].dim === priceBase.dim || priceBase.dim === "count")) {
    unit = catalogueUnitFor(pack.unit);
    unitSizeMilli = Math.max(1, Math.round(pack.size * 1000));
    sell = { dim: UNIT_BASE[pack.unit].dim, amount: pack.size * UNIT_BASE[pack.unit].factor };
  } else {
    unit = catalogueUnitFor(priceUnit);
    sell = { dim: priceBase.dim, amount: priceBase.factor };
    loose = priceBase.dim === "g" || priceBase.dim === "ml";
    if (priceUnit === "metre") notes.push("Sold per metre: listed as pieces, one piece = one metre.");
    if (priceUnit === "custom") notes.push(`Sold per ${said.customUnit ?? "unit"}: listed as pieces, one piece = one ${said.customUnit ?? "unit"}.`);
    if (priceUnit === "box") notes.push("Sold per box: listed as packs, one pack = one box.");
  }

  let pricePaise: number | null = said.pricePaise;
  if (pricePaise !== null && priceBase.dim === sell.dim && priceBase.factor !== sell.amount) {
    pricePaise = Math.round((pricePaise * sell.amount) / priceBase.factor);
  } else if (pricePaise !== null && priceBase.dim !== sell.dim && priceBase.dim !== "count") {
    notes.push("The price was said per a different measure than the pack; check the price of one pack.");
  }

  let stock: number | null = said.stock;
  if (stock !== null) {
    const stockBase = UNIT_BASE[said.stockUnit ?? priceUnit];
    if (stockBase.dim === sell.dim) stock = (stock * stockBase.factor) / sell.amount;
    else if (stockBase.dim === "count") stock = stock * stockBase.factor; // 50 bottles of a 1 L pack = 50 packs
    else notes.push("The stock was said in a different measure than the pack; check the stock.");
    stock = loose ? Math.round(stock * 1000) / 1000 : Math.floor(stock + 1e-9);
  }
  return { unit, unitSizeMilli, loose, pricePaise, stock, notes };
}

/** True when the selling price of one pack is above the MRP read from that pack. */
export function priceAboveMrp(pricePaise: number | null, mrpPaise: number | null): boolean {
  return pricePaise !== null && mrpPaise !== null && mrpPaise > 0 && pricePaise > mrpPaise;
}
