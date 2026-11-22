/**
 * Quantities and units as people write and say them in India
 * (docs/smart-shopping-2026-11): regional digits (२, ૨, ২, ௨ …), number words
 * in Marathi / Hindi / English ("दोन", "पाच", "बारा", "twelve"), fractions
 * ("अर्धा", "पाव", "दीड", "सव्वा", "पावणे दोन"), and unit words ("किलो",
 * "ग्रॅम", "लिटर", "नग", "डझन", "पाकीट"). Pure and client-safe.
 *
 * Measures are normalised to a base: grams for weight, millilitres for volume,
 * pieces for counts (a dozen = 12 pieces); packet, box and metre stay as they are.
 */

export type BaseUnit = "g" | "ml" | "piece" | "pack" | "box" | "m";

export interface ParsedQuantity {
  /** Amount in the base unit: 0.5 kg → 500 (g). */
  amount: number;
  unit: BaseUnit;
  /** What it was written as, for display: "0.5 kg", "250 g", "12 piece". */
  display: string;
}

const DIGIT_BLOCKS = [0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0660, 0x06f0];

/** Replaces Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam and Arabic/Urdu digits with 0–9. */
export function asciiDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const block = DIGIT_BLOCKS.find((start) => code >= start && code <= start + 9);
    out += block === undefined ? ch : String(code - block);
  }
  return out;
}

const NUMBER_WORDS: Record<string, number> = {
  // English
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, "twenty five": 25, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12, half: 0.5, quarter: 0.25,
  // Marathi
  एक: 1, दोन: 2, तीन: 3, चार: 4, पाच: 5, सहा: 6, सात: 7, आठ: 8, नऊ: 9, दहा: 10, अकरा: 11, बारा: 12,
  तेरा: 13, चौदा: 14, पंधरा: 15, सोळा: 16, सतरा: 17, अठरा: 18, एकोणीस: 19, वीस: 20, पंचवीस: 25, तीस: 30,
  चाळीस: 40, पन्नास: 50, साठ: 60, सत्तर: 70, ऐंशी: 80, नव्वद: 90, शंभर: 100, हजार: 1000,
  // Hindi
  दो: 2, पांच: 5, पाँच: 5, छह: 6, छः: 6, नौ: 9, दस: 10, ग्यारह: 11, बारह: 12, पंद्रह: 15, बीस: 20,
  पच्चीस: 25, चालीस: 40, पचास: 50, सौ: 100,
  // Fractions (Marathi / Hindi)
  अर्धा: 0.5, अर्धी: 0.5, अर्ध: 0.5, आधा: 0.5, आधी: 0.5, पाव: 0.25, सव्वा: 1.25, दीड: 1.5, डेढ़: 1.5, डेढ: 1.5,
  अडीच: 2.5, ढाई: 2.5, साडेतीन: 3.5,
};

type UnitInfo = { unit: BaseUnit; factor: number };

const UNIT_WORDS: Record<string, UnitInfo> = {
  kg: { unit: "g", factor: 1000 }, kgs: { unit: "g", factor: 1000 }, kilo: { unit: "g", factor: 1000 },
  kilogram: { unit: "g", factor: 1000 }, kilograms: { unit: "g", factor: 1000 },
  किलो: { unit: "g", factor: 1000 }, किग्रा: { unit: "g", factor: 1000 }, केजी: { unit: "g", factor: 1000 },
  g: { unit: "g", factor: 1 }, gm: { unit: "g", factor: 1 }, gms: { unit: "g", factor: 1 }, gram: { unit: "g", factor: 1 },
  grams: { unit: "g", factor: 1 }, ग्रॅम: { unit: "g", factor: 1 }, ग्राम: { unit: "g", factor: 1 }, ग्रा: { unit: "g", factor: 1 },
  l: { unit: "ml", factor: 1000 }, lt: { unit: "ml", factor: 1000 }, ltr: { unit: "ml", factor: 1000 },
  litre: { unit: "ml", factor: 1000 }, litres: { unit: "ml", factor: 1000 }, liter: { unit: "ml", factor: 1000 },
  liters: { unit: "ml", factor: 1000 }, लिटर: { unit: "ml", factor: 1000 }, लीटर: { unit: "ml", factor: 1000 },
  ml: { unit: "ml", factor: 1 }, मिली: { unit: "ml", factor: 1 }, एमएल: { unit: "ml", factor: 1 },
  pc: { unit: "piece", factor: 1 }, pcs: { unit: "piece", factor: 1 }, piece: { unit: "piece", factor: 1 },
  pieces: { unit: "piece", factor: 1 }, nos: { unit: "piece", factor: 1 }, no: { unit: "piece", factor: 1 },
  nug: { unit: "piece", factor: 1 }, nag: { unit: "piece", factor: 1 }, नग: { unit: "piece", factor: 1 },
  नंग: { unit: "piece", factor: 1 }, पीस: { unit: "piece", factor: 1 }, bottle: { unit: "piece", factor: 1 },
  bottles: { unit: "piece", factor: 1 }, बाटली: { unit: "piece", factor: 1 }, बोतल: { unit: "piece", factor: 1 },
  dozen: { unit: "piece", factor: 12 }, doz: { unit: "piece", factor: 12 }, dz: { unit: "piece", factor: 12 },
  डझन: { unit: "piece", factor: 12 }, दर्जन: { unit: "piece", factor: 12 }, दर्जन्: { unit: "piece", factor: 12 },
  packet: { unit: "pack", factor: 1 }, packets: { unit: "pack", factor: 1 }, pack: { unit: "pack", factor: 1 },
  pkt: { unit: "pack", factor: 1 }, पाकीट: { unit: "pack", factor: 1 }, पाकिट: { unit: "pack", factor: 1 },
  पॅकेट: { unit: "pack", factor: 1 }, पैकेट: { unit: "pack", factor: 1 }, पुडा: { unit: "pack", factor: 1 },
  box: { unit: "box", factor: 1 }, boxes: { unit: "box", factor: 1 }, बॉक्स: { unit: "box", factor: 1 },
  डबा: { unit: "box", factor: 1 }, डिब्बा: { unit: "box", factor: 1 },
  m: { unit: "m", factor: 1 }, metre: { unit: "m", factor: 1 }, meter: { unit: "m", factor: 1 },
  metres: { unit: "m", factor: 1 }, मीटर: { unit: "m", factor: 1 },
};

/** A unit word → base unit and factor, or null. */
export function unitFromWord(word: string): UnitInfo | null {
  const key = asciiDigits(word).trim().toLowerCase().replace(/[.।]+$/, "");
  return UNIT_WORDS[key] ?? null;
}

function tokenize(text: string): string[] {
  return asciiDigits(text)
    .toLowerCase()
    .replace(/(\d)([^\d\s.,/])/gu, "$1 $2") // "2kg" → "2 kg"
    .replace(/[,;:()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function numberOf(token: string): number | null {
  if (/^\d+(\.\d+)?$/.test(token)) return Number(token);
  if (/^\d+\/\d+$/.test(token)) {
    const [a, b] = token.split("/").map(Number);
    return b ? a / b : null;
  }
  return NUMBER_WORDS[token] ?? null;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function displayOf(amount: number, unit: BaseUnit): string {
  if (unit === "g" && amount >= 1000) return `${round(amount / 1000)} kg`;
  if (unit === "ml" && amount >= 1000) return `${round(amount / 1000)} L`;
  return `${round(amount)} ${unit}`;
}

/**
 * The quantity written in a line, or null when there is none.
 *   "साखर १ किलो" → 1000 g · "अर्धा किलो" → 500 g · "पाव किलो" / "पाव" (alone) → 250 g
 *   "पावणे दोन किलो" → 1750 g · "दूध २ लिटर" → 2000 ml · "अंडी १ डझन" → 12 piece
 *   "साबण ४ नग" → 4 piece · "2kg" → 2000 g · "500 gm" → 500 g
 * A number without a unit is a count of pieces.
 */
export function parseQuantity(text: string): ParsedQuantity | null {
  const tokens = tokenize(text);
  let value: number | null = null;
  let unit: UnitInfo | null = null;
  let lessQuarter = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "पावणे" || t === "पौने") {
      lessQuarter = true;
      continue;
    }
    const u = unitFromWord(t);
    if (u && value !== null) {
      unit = u;
      break;
    }
    if (u && value === null && u.factor === 12) {
      // "डझन" alone = one dozen
      value = 1;
      unit = u;
      break;
    }
    const n = numberOf(t);
    if (n !== null) {
      // "दोन पाव" = 2 × 250 g; "पाव" after a number is a quarter-kilo unit.
      if (t === "पाव" && value !== null) {
        unit = { unit: "g", factor: 250 };
        break;
      }
      // "दोन हजार" = 2 × 1000; "एकशे पाच"-style sums are rare on lists: a later small number adds to a hundred+.
      if (value === null) value = n;
      else if (n >= 100) value *= n;
      else if (value >= 100) value += n;
      else value = n;
    }
  }
  if (value === null) return null;
  if (lessQuarter) value = value - 0.25;
  if (!unit) {
    // "पाव" or "अर्धा" alone in a grocery list means a quarter / half kilo.
    if (tokens.includes("पाव") || tokens.includes("अर्धा") || tokens.includes("आधा")) unit = { unit: "g", factor: 1000 };
    else unit = { unit: "piece", factor: 1 };
  }
  const amount = round(value * unit.factor);
  if (!(amount > 0)) return null;
  return { amount, unit: unit.unit, display: displayOf(amount, unit.unit) };
}

/** A catalogue product's pack in base units: unit "kg" size 1000 milli → 1000 g. Null when not comparable. */
export function packInBase(productUnit: string, unitSizeMilli: number): { amount: number; unit: BaseUnit } | null {
  const size = unitSizeMilli / 1000;
  switch (productUnit) {
    case "kg":
      return { amount: size * 1000, unit: "g" };
    case "g":
      return { amount: size, unit: "g" };
    case "L":
      return { amount: size * 1000, unit: "ml" };
    case "ml":
      return { amount: size, unit: "ml" };
    case "piece":
      return { amount: size, unit: "piece" };
    case "dozen":
      return { amount: size * 12, unit: "piece" };
    case "pack":
      return { amount: size, unit: "pack" };
    default:
      return null;
  }
}

export interface PackPlan {
  /** Packs to put in the cart (at least 1). */
  packs: number;
  /** What those packs add up to, in the request's base unit. */
  supplied: number;
  /** supplied − requested (positive = more than asked). 0 when it divides evenly. */
  difference: number;
  /** "2 × 1 kg = 2 kg" / "3 × 500 g = 1.5 kg (asked 1.25 kg)". */
  note: string;
}

/**
 * How many of a shop's packs meet a request: 2 kg with 1 kg packs → 2 packs; 1.25 kg with 500 g packs → 3 packs
 * (the nearest pack count, never zero). A request in packets/pieces of a product sold by weight is taken as that
 * many packs. Null when the units cannot be compared (litres asked, kilos sold).
 */
export function planPacks(request: ParsedQuantity, pack: { amount: number; unit: BaseUnit }): PackPlan | null {
  if (request.unit === "pack" || request.unit === "box" || (request.unit === "piece" && pack.unit !== "piece")) {
    const packs = Math.max(1, Math.round(request.amount));
    return { packs, supplied: packs * pack.amount, difference: 0, note: `${packs} × ${displayOf(pack.amount, pack.unit)}` };
  }
  if (request.unit !== pack.unit || !(pack.amount > 0)) return null;
  const exact = request.amount / pack.amount;
  const packs = Math.max(1, Math.round(exact));
  const supplied = round(packs * pack.amount);
  const difference = round(supplied - request.amount);
  const base = `${packs} × ${displayOf(pack.amount, pack.unit)} = ${displayOf(supplied, pack.unit)}`;
  return { packs, supplied, difference, note: difference === 0 ? base : `${base} (asked ${request.display})` };
}

/** A single number token — digits (any script), a fraction "1/2" or a number word ("साठ", "twelve") — or null. */
export function numberFromWord(word: string): number | null {
  return numberOf(asciiDigits(word).trim().toLowerCase());
}
