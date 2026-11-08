/**
 * Bulk product upload: the unit a row is sold in, and the checks shown in the
 * preview before anything is imported (docs/audit/order-payment-gst-audit.md,
 * Area 5). Pure.
 *
 * `rowErrors` are the owner's mandatory-field and value rules (08 Nov 2026):
 * a row with any of them is rejected — shown with its errors, never imported,
 * while the file's other rows still go in. `previewChecks` are warnings: they
 * never block the row; they say what will happen.
 */
import { STANDARD_GST_RATES } from "@/server/gst/product-rates";
import type { ImportFields } from "./fields";

const UNIT_MAP: Record<string, string> = {
  pcs: "piece", pc: "piece", piece: "piece", pieces: "piece", count: "piece", nos: "piece", no: "piece", unit: "piece", units: "piece",
  kg: "kg", g: "g", gm: "g", gram: "g", grams: "g", l: "L", ltr: "L", litre: "L", liter: "L", ml: "ml", pack: "pack", packet: "pack", box: "pack",
};

/** Units a loose good can be sold in. */
export const LOOSE_UNITS = new Set(["kg", "g", "L", "ml"]);

export function unitFor(f: ImportFields): string {
  for (const v of [f.unit, f.unitCountType]) {
    const key = v?.trim().toLowerCase();
    if (key && UNIT_MAP[key]) return UNIT_MAP[key];
  }
  return "piece";
}

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

const VALUE_LABEL: Record<string, string> = { mrp: "MRP", price: "Selling Price", salePrice: "Sale Price", gstPercent: "GST %" };

/**
 * Why a row cannot be imported, column by column ("MRP missing", "Selling
 * Price ₹40.00 > MRP ₹34.00"). Empty = the row is fine. A Delete row only
 * needs to find its product, so it is not checked here.
 *
 * `categoryKnown` says whether a Category the row names matches a GoKesari
 * category (undefined when the row names none).
 */
export function rowErrors(f: ImportFields, opts: { categoryKnown?: boolean } = {}): string[] {
  if (f.action === "DELETE") return [];
  const out: string[] = [];
  if (!f.name) out.push("Product Name missing");
  const category = f.category ?? f.categoryHints?.[0] ?? f.productType;
  if (!category) out.push("Category missing");
  else if (f.category && opts.categoryKnown === false) out.push(`Invalid category "${f.category}" — choose one from the Category list`);
  const loose = f.goodsKind === "LOOSE";
  for (const [field, raw] of Object.entries(f.invalidValues ?? {})) {
    if (field === "mrp" && loose) continue;
    out.push(`${VALUE_LABEL[field] ?? field} "${raw}" is not a valid ${field === "gstPercent" ? "GST rate" : "amount (a number, 0 or more)"}`);
  }
  if (!loose && f.mrpPaise == null && !f.invalidValues?.mrp) out.push("MRP missing");
  if (f.quantityInvalid != null) out.push(`Stock Qty "${f.quantityInvalid}" is not a valid quantity (a number, 0 or more)`);
  else if (f.quantity == null) out.push("Stock Qty missing");
  if (f.pricePaise != null && f.pricePaise <= 0) out.push("Selling Price must be more than 0");
  if (f.pricePaise != null && f.mrpPaise != null && f.pricePaise > f.mrpPaise) {
    out.push(`Selling Price ${rupees(f.pricePaise)} > MRP ${rupees(f.mrpPaise)}`);
  }
  if (f.salePricePaise != null && f.mrpPaise != null && f.salePricePaise > f.mrpPaise) {
    out.push(`Sale Price ${rupees(f.salePricePaise)} > MRP ${rupees(f.mrpPaise)}`);
  }
  if (f.gstRateBp != null && !(STANDARD_GST_RATES as readonly number[]).includes(f.gstRateBp / 100)) {
    out.push(`GST ${f.gstRateBp / 100}% is not a GST rate in India (${STANDARD_GST_RATES.join(", ")}%)`);
  }
  return out;
}

export function previewChecks(f: ImportFields): string[] {
  const out: string[] = [];
  if (f.goodsKind === "LOOSE" && !LOOSE_UNITS.has(unitFor(f))) {
    out.push("Check: a loose good is sold by weight or volume — set Unit to kg, g, l or ml; it is added as packaged until then.");
  }
  return out;
}
