/**
 * Bulk product upload: the unit a row is sold in, and the checks shown in the
 * preview before anything is imported (docs/audit/order-payment-gst-audit.md,
 * Area 5). Pure.
 *
 * The checks repeat the rules the import applies — a price above the file's
 * MRP is not saved — and the GST data an invoice needs. They never block the
 * row; they say what will happen.
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

export function previewChecks(f: ImportFields): string[] {
  const out: string[] = [];
  if (f.pricePaise != null && f.pricePaise <= 0) out.push("Check: Selling Price must be more than 0; the price will not be changed.");
  if (f.pricePaise != null && f.mrpPaise != null && f.pricePaise > f.mrpPaise) {
    out.push(`Check: Selling Price ₹${(f.pricePaise / 100).toFixed(2)} is above the MRP ₹${(f.mrpPaise / 100).toFixed(2)}; the price will not be changed.`);
  }
  if (f.gstRateBp != null && !(STANDARD_GST_RATES as readonly number[]).includes(f.gstRateBp / 100)) {
    out.push(`Check: GST ${f.gstRateBp / 100}% is not a GST rate in India (${STANDARD_GST_RATES.join(", ")}%); correct it before invoices use it.`);
  }
  if (f.goodsKind === "LOOSE" && !LOOSE_UNITS.has(unitFor(f))) {
    out.push("Check: a loose good is sold by weight or volume — set Unit to kg, g, l or ml; it is added as packaged until then.");
  }
  return out;
}
