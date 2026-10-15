/**
 * Units on supplier bills vs the shop's sellable units (docs/inventory-accounting-2026-10).
 *
 * Stock is counted in a listing's sellable units ×1000 ("milli units"): a
 * 500 g pack listing holds 12 packs as 12000; a loose 1 kg rice listing holds
 * 2.5 kg as 2500. A listing is described by the master product's `unit`
 * (L, ml, kg, g, piece, pack) and `unitSizeMilli` (size of one sellable unit
 * in milli of that unit: 1 L → 1000, a 500 ml pouch listed in L → 500).
 *
 * A bill line says "10 kg", "2 L", "24 pcs", "1 case". Weight and volume
 * convert exactly; count words (pcs, nos, pkt) mean sellable units; anything
 * else needs a conversion the owner saves once (a "case" of this item is 24).
 */

export type Dimension = "mass" | "volume" | "count";

/** Canonical unit → [dimension, size in the dimension's base (g, ml, piece)]. */
const CANONICAL: Record<string, [Dimension, number]> = {
  kg: ["mass", 1000],
  g: ["mass", 1],
  mg: ["mass", 0.001],
  quintal: ["mass", 100_000],
  tonne: ["mass", 1_000_000],
  l: ["volume", 1000],
  ml: ["volume", 1],
  piece: ["count", 1],
  dozen: ["count", 12],
};

/** Spellings on Indian bills (English, Hindi, Marathi) → canonical. */
const ALIASES: Record<string, string> = {
  kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", kilogram: "kg", kilograms: "kg", "किलो": "kg", "किग्रा": "kg", "कि.ग्रा.": "kg",
  g: "g", gm: "g", gms: "g", gr: "g", gram: "g", grams: "g", grm: "g", "ग्राम": "g", "ग्रॅम": "g",
  mg: "mg",
  qtl: "quintal", quintal: "quintal", "क्विंटल": "quintal",
  t: "tonne", ton: "tonne", tonne: "tonne", mt: "tonne",
  l: "l", lt: "l", ltr: "l", ltrs: "l", litre: "l", litres: "l", liter: "l", liters: "l", "लीटर": "l", "लिटर": "l",
  ml: "ml", mls: "ml", millilitre: "ml", milliliter: "ml", "मिली": "ml",
  pc: "piece", pcs: "piece", piece: "piece", pieces: "piece", nos: "piece", no: "piece", "no.": "piece", "nos.": "piece", n: "piece",
  unit: "piece", units: "piece", ea: "piece", each: "piece", pkt: "piece", pkts: "piece", packet: "piece", packets: "piece",
  pack: "piece", packs: "piece", pouch: "piece", pouches: "piece", bottle: "piece", bottles: "piece", btl: "piece",
  tin: "piece", tins: "piece", jar: "piece", jars: "piece", can: "piece", cans: "piece",
  "नग": "piece", "पीस": "piece", "पॅकेट": "piece", "पैकेट": "piece",
  dz: "dozen", doz: "dozen", dozen: "dozen", "दर्जन": "dozen", "डझन": "dozen",
};

/** GST portal UQC codes → canonical (e-invoices and GST bills use these). */
const UQC: Record<string, string> = {
  KGS: "kg", GMS: "g", MGS: "mg", QTL: "quintal", TON: "tonne", MTS: "tonne",
  LTR: "l", MLT: "ml", KLR: "kl",
  NOS: "piece", PCS: "piece", UNT: "piece", PAC: "piece", BTL: "piece", CAN: "piece", TIN: "piece", PRS: "piece",
  DOZ: "dozen",
};

export function normaliseUnit(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (UQC[trimmed.toUpperCase()]) return UQC[trimmed.toUpperCase()] === "kl" ? null : UQC[trimmed.toUpperCase()];
  const key = trimmed.toLowerCase().replace(/\s+/g, "");
  return ALIASES[key] ?? ALIASES[key.replace(/\.$/, "")] ?? key;
}

export function unitDimension(canonical: string | null): Dimension | null {
  return canonical && CANONICAL[canonical] ? CANONICAL[canonical][0] : null;
}

export interface ListingUnit {
  /** Master product unit: L, ml, kg, g, piece, pack. */
  unit: string;
  /** Size of one sellable unit in milli of `unit` (1 L → 1000). */
  unitSizeMilli: number;
}

export type ConversionResult =
  | { ok: true; stockQtyMilli: number; method: "same" | "dimension" | "count" | "saved" }
  | { ok: false; reason: "UNKNOWN_UNIT" | "DIMENSION_MISMATCH" | "NOT_WHOLE"; message: string };

/**
 * Bill quantity → milli sellable units of the listing.
 * `saved` is a conversion the owner stored for this unit (milli sellable units per 1 bill unit).
 */
export function toStockQtyMilli(qtyMilli: number, billUnit: string | null | undefined, listing: ListingUnit, saved?: number | null): ConversionResult {
  if (saved && saved > 0) {
    return { ok: true, stockQtyMilli: Math.round((qtyMilli * saved) / 1000), method: "saved" };
  }
  const bill = normaliseUnit(billUnit);
  const stock = normaliseUnit(listing.unit) ?? "piece";
  // No unit on the bill: it counts sellable units.
  if (!bill) return { ok: true, stockQtyMilli: qtyMilli, method: "count" };
  const billDef = CANONICAL[bill];
  const stockDef = CANONICAL[stock];
  if (!billDef) return { ok: false, reason: "UNKNOWN_UNIT", message: `Unknown unit "${billUnit}". Choose how many sellable units one ${billUnit} is.` };
  if (billDef[0] === "count") {
    // pcs / dozen → sellable units (a dozen is 12 of them).
    return { ok: true, stockQtyMilli: Math.round(qtyMilli * billDef[1]), method: bill === stock ? "same" : "count" };
  }
  if (!stockDef || stockDef[0] === "count") {
    return { ok: false, reason: "DIMENSION_MISMATCH", message: `The bill says ${billUnit} but this product is sold by the piece. Set how many pieces one ${billUnit} is.` };
  }
  if (billDef[0] !== stockDef[0]) {
    return { ok: false, reason: "DIMENSION_MISMATCH", message: `The bill says ${billUnit} (${billDef[0]}) but this product is sold by ${listing.unit} (${stockDef[0]}).` };
  }
  // In the dimension's base (g or ml), ×1000: qtyMilli × billBase.
  const billBaseMilli = qtyMilli * billDef[1];
  // One sellable unit in base ×1000: unitSizeMilli × stockBase.
  const sellableBaseMilli = listing.unitSizeMilli * stockDef[1];
  if (sellableBaseMilli <= 0) return { ok: false, reason: "UNKNOWN_UNIT", message: "This product has no unit size." };
  return { ok: true, stockQtyMilli: Math.round((billBaseMilli * 1000) / sellableBaseMilli), method: bill === stock && listing.unitSizeMilli === 1000 ? "same" : "dimension" };
}

/** "12.5 pack", "3 kg" — a milli quantity for people. */
export function formatMilli(qtyMilli: number, unit?: string | null): string {
  const value = qtyMilli / 1000;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return unit ? `${text} ${unit}` : text;
}

/** Name of one sellable unit of a listing: "1 L", "500 g", "piece". */
export function sellableUnitLabel(listing: ListingUnit): string {
  const stock = normaliseUnit(listing.unit) ?? listing.unit;
  if (unitDimension(stock) === "count") return listing.unit;
  return `${formatMilli(listing.unitSizeMilli)} ${listing.unit}`;
}
