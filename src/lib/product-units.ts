/**
 * The selling units the catalogue knows (products.unit: "L, ml, kg, g, piece,
 * pack"), and the spellings owners type for them. The create-product API
 * accepts only these, and the owner's form offers them as a list — "bananas"
 * used to be saved as a unit (TC-FLD-074). Pure and client-safe.
 */
export const PRODUCT_UNITS = ["piece", "pack", "dozen", "kg", "g", "L", "ml"] as const;
export type ProductUnit = (typeof PRODUCT_UNITS)[number];

export const PRODUCT_UNIT_LABELS: Record<ProductUnit, string> = {
  piece: "piece",
  pack: "pack",
  dozen: "dozen",
  kg: "kg",
  g: "g",
  L: "L (litre)",
  ml: "ml",
};

const ALIASES: Record<string, ProductUnit> = {
  piece: "piece", pieces: "piece", pc: "piece", pcs: "piece", nos: "piece", no: "piece", unit: "piece", units: "piece", each: "piece",
  pack: "pack", packs: "pack", packet: "pack", packets: "pack", pkt: "pack",
  dozen: "dozen", doz: "dozen", dz: "dozen",
  kg: "kg", kgs: "kg", kilo: "kg", kilogram: "kg", kilograms: "kg",
  g: "g", gm: "g", gms: "g", gram: "g", grams: "g",
  l: "L", lt: "L", ltr: "L", litre: "L", litres: "L", liter: "L", liters: "L",
  ml: "ml", millilitre: "ml", milliliter: "ml",
};

/** The catalogue unit for what was typed ("Kg", "litre", "pcs"), or null when it is not one. */
export function normaliseProductUnit(raw: string | null | undefined): ProductUnit | null {
  const key = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  return ALIASES[key] ?? null;
}
