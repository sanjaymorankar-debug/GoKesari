/**
 * Quantity, pack and dimension parsing.
 *
 *   "1 kg" / "1000 g" / "1,000 grams"  ->  { unitValue: 1000, unit: "g" }   label "1000 g"
 *   "6 x 200 ml" / "200ml x 6"         ->  multiplier 6, unitValue 200 ml    label "6 x 200 ml"
 *   "Pack of 3"                        ->  3 pcs
 *
 * Canonical base units: g, ml, pcs, mm. The caller keeps the original text.
 * A multipack is NOT collapsed into its total when comparing products: "2 x 500 g"
 * and "1 kg" have the same total but are different sellable packs, so both the
 * per-unit size and the multiplier are preserved.
 */
import type { BaseUnit, Quantity } from "../types";

interface UnitDef {
  unit: BaseUnit;
  factor: number;
}

const def = (unit: BaseUnit, factor: number): UnitDef => ({ unit, factor });

const UNIT_TABLE: Record<string, UnitDef> = {
  // mass -> g
  mg: def("g", 0.001),
  g: def("g", 1), gm: def("g", 1), gms: def("g", 1), gr: def("g", 1), grm: def("g", 1),
  gram: def("g", 1), grams: def("g", 1),
  kg: def("g", 1000), kgs: def("g", 1000), kilo: def("g", 1000), kilos: def("g", 1000),
  kilogram: def("g", 1000), kilograms: def("g", 1000),
  lb: def("g", 453.59237), lbs: def("g", 453.59237), pound: def("g", 453.59237), pounds: def("g", 453.59237),
  oz: def("g", 28.349523125), ounce: def("g", 28.349523125), ounces: def("g", 28.349523125),
  // volume -> ml
  ml: def("ml", 1), mls: def("ml", 1), millilitre: def("ml", 1), millilitres: def("ml", 1),
  milliliter: def("ml", 1), milliliters: def("ml", 1), cc: def("ml", 1),
  cl: def("ml", 10), dl: def("ml", 100),
  l: def("ml", 1000), lt: def("ml", 1000), ltr: def("ml", 1000), ltrs: def("ml", 1000),
  litre: def("ml", 1000), litres: def("ml", 1000), liter: def("ml", 1000), liters: def("ml", 1000),
  floz: def("ml", 29.5735295625),
  // length -> mm
  mm: def("mm", 1), cm: def("mm", 10),
  m: def("mm", 1000), mtr: def("mm", 1000), meter: def("mm", 1000), metre: def("mm", 1000),
  meters: def("mm", 1000), metres: def("mm", 1000),
  in: def("mm", 25.4), inch: def("mm", 25.4), inches: def("mm", 25.4),
  ft: def("mm", 304.8), feet: def("mm", 304.8), foot: def("mm", 304.8),
  // count -> pcs
  pcs: def("pcs", 1), pc: def("pcs", 1), piece: def("pcs", 1), pieces: def("pcs", 1),
  nos: def("pcs", 1), unit: def("pcs", 1), units: def("pcs", 1), ct: def("pcs", 1), count: def("pcs", 1),
  dozen: def("pcs", 12), doz: def("pcs", 12),
};

const UNIT_ALT = Object.keys(UNIT_TABLE)
  .sort((x, y) => y.length - x.length)
  .join("|");

const NUM = String.raw`\d+(?:\.\d+)?`;
/** unit must be followed by a non-letter so "2 gram" does not read as "2 g" + "ram". */
const UNIT = String.raw`(${UNIT_ALT})(?![a-z])`;

const RE_MULT_FIRST = new RegExp(String.raw`(?<![\d.])(\d+)\s*x\s*(${NUM})\s*${UNIT}`, "g");
const RE_MULT_LAST = new RegExp(String.raw`(?<![\d.])(${NUM})\s*${UNIT}\s*x\s*(\d+)(?!\d)`, "g");
const RE_SINGLE = new RegExp(String.raw`(?<![\d.])(${NUM})\s*${UNIT}`, "g");
const RE_PACK_OF = /\b(?:pack|set|combo|box|carton)\s+of\s+(\d+)\b|\b(\d+)\s*(?:-\s*)?(?:pack|pk)\b/g;

function prepare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[×✕✖*]/g, "x")
    .replace(/\bfl\.?\s*oz\b/g, "floz")
    .replace(/(?<=\d),(?=\d{3}(?!\d))/g, "")
    .replace(/[()[\]{}]/g, " ");
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function formatNumber(n: number): string {
  return Number(n.toFixed(4)).toString();
}

export function formatQuantityLabel(unitValue: number, unit: BaseUnit, multiplier: number): string {
  const one = `${formatNumber(unitValue)} ${unit}`;
  return multiplier > 1 ? `${multiplier} x ${one}` : one;
}

interface Hit {
  index: number;
  length: number;
  q: Omit<Quantity, "label" | "original">;
}

/**
 * Free-text titles are noisier than an explicit quantity field, so title parsing is stricter:
 * only pack-like units (g / ml / pcs) count - "2 in 1" and "6 mm yoga mat" are not pack sizes -
 * and "5G" is a network generation, not five grams.
 */
export interface QuantityOptions {
  fromTitle?: boolean;
}

const TITLE_UNITS: readonly BaseUnit[] = ["g", "ml", "pcs"];
const NETWORK_GENERATION = /^[2-6]g$/;

function makeQuantity(
  value: number,
  unitWord: string,
  multiplier: number,
  raw: string,
  opts: QuantityOptions,
): Omit<Quantity, "label" | "original"> | null {
  const d = UNIT_TABLE[unitWord];
  if (!d || !Number.isFinite(value) || value <= 0 || multiplier < 1) return null;
  // Only the unspaced token is ambiguous: "5G" is a network, "5 g" is five grams.
  if (opts.fromTitle && (!TITLE_UNITS.includes(d.unit) || NETWORK_GENERATION.test(raw))) return null;
  const unitValue = round4(value * d.factor);
  if (unitValue <= 0) return null;
  return { unitValue, unit: d.unit, multiplier, total: round4(unitValue * multiplier) };
}

function collectHits(s: string, opts: QuantityOptions): { multi: Hit[]; single: Hit[] } {
  const multi: Hit[] = [];
  const single: Hit[] = [];

  for (const m of s.matchAll(RE_MULT_FIRST)) {
    const q = makeQuantity(parseFloat(m[2]), m[3], parseInt(m[1], 10), m[0], opts);
    if (q) multi.push({ index: m.index!, length: m[0].length, q });
  }
  for (const m of s.matchAll(RE_MULT_LAST)) {
    const q = makeQuantity(parseFloat(m[1]), m[2], parseInt(m[3], 10), m[0], opts);
    if (q) multi.push({ index: m.index!, length: m[0].length, q });
  }
  for (const m of s.matchAll(RE_SINGLE)) {
    const q = makeQuantity(parseFloat(m[1]), m[2], 1, m[0], opts);
    if (q) single.push({ index: m.index!, length: m[0].length, q });
  }
  return { multi, single };
}

/**
 * Parses the pack size out of free text. Returns null when there is no
 * recognisable quantity - the caller must then treat pack size as unknown,
 * never as zero or one.
 */
export function parseQuantity(text: string | null | undefined, opts: QuantityOptions = {}): Quantity | null {
  if (!text) return null;
  const s = prepare(text);
  const { multi, single } = collectHits(s, opts);

  // A structured multipack ("6 x 200 ml") beats a bare size; among equals the leftmost wins.
  const pick = (hits: Hit[]) => hits.sort((a, b) => a.index - b.index)[0];
  let chosen = multi.length ? pick(multi) : single.length ? pick(single) : null;

  // "500 g, pack of 2": a separate pack-count phrase multiplies a single size.
  if (chosen && chosen.q.multiplier === 1) {
    RE_PACK_OF.lastIndex = 0;
    const p = RE_PACK_OF.exec(s);
    const n = p ? parseInt(p[1] ?? p[2], 10) : NaN;
    if (Number.isFinite(n) && n > 1) {
      chosen = { ...chosen, q: { ...chosen.q, multiplier: n, total: round4(chosen.q.unitValue * n) } };
    }
  }

  // "Pack of 6" with no size at all: six pieces.
  if (!chosen) {
    RE_PACK_OF.lastIndex = 0;
    const p = RE_PACK_OF.exec(s);
    const n = p ? parseInt(p[1] ?? p[2], 10) : NaN;
    if (Number.isFinite(n) && n >= 1) {
      chosen = { index: p!.index, length: p![0].length, q: { unitValue: 1, unit: "pcs", multiplier: n, total: n } };
    }
  }
  if (!chosen) return null;

  const { unitValue, unit, multiplier, total } = chosen.q;
  return {
    unitValue,
    unit,
    multiplier,
    total,
    label: formatQuantityLabel(unitValue, unit, multiplier),
    original: text.trim(),
  };
}

/** Removes the quantity phrases from a product name so what is left is the product's identity. */
export function stripQuantityFromText(text: string, opts: QuantityOptions = {}): string {
  let s = prepare(text);
  const { multi, single } = collectHits(s, opts);

  // "6 x 50 g" contains "50 g": keep the structured span and drop any single hit inside it,
  // otherwise removing both would cut the string twice over the same characters.
  const kept: Hit[] = [];
  const overlaps = (h: Hit) => kept.some((k) => h.index < k.index + k.length && k.index < h.index + h.length);
  for (const h of [...multi].sort((a, b) => a.index - b.index || b.length - a.length)) if (!overlaps(h)) kept.push(h);
  for (const h of [...single].sort((a, b) => a.index - b.index)) if (!overlaps(h)) kept.push(h);

  for (const h of kept.sort((a, b) => b.index - a.index)) {
    s = s.slice(0, h.index) + " " + s.slice(h.index + h.length);
  }
  s = s.replace(RE_PACK_OF, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Net weight / volume expressed in the requested base unit, or null when the text is in another dimension. */
export function parseMeasure(text: string | null | undefined, unit: "g" | "ml"): number | null {
  const q = parseQuantity(text);
  return q && q.unit === unit ? q.total : null;
}

export interface Dimensions {
  length: number;
  width: number;
  height: number;
}

const RE_DIMS = new RegExp(
  String.raw`(${NUM})\s*(?:x|by)\s*(${NUM})\s*(?:x|by)\s*(${NUM})\s*${UNIT}`,
);

/** "10 x 20 x 30 cm" -> millimetres. Requires all three axes and a length unit. */
export function parseDimensions(text: string | null | undefined): Dimensions | null {
  if (!text) return null;
  const m = RE_DIMS.exec(prepare(text));
  if (!m) return null;
  const d = UNIT_TABLE[m[4]];
  if (!d || d.unit !== "mm") return null;
  const [l, w, h] = [m[1], m[2], m[3]].map((v) => round4(parseFloat(v) * d.factor));
  if (![l, w, h].every((v) => v > 0)) return null;
  return { length: l, width: w, height: h };
}
