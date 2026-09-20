/**
 * GST rate and HSN code normalisation.
 *
 * Rates are integer basis points (18% -> 1800), matching GoKesari's
 * products.gst_rate_bp. Slab validity is data-driven (config.GST_SLABS_BP) because
 * India's slabs change: a rate that is no longer current is accepted and flagged
 * LEGACY, not rejected - older source data is still true of the product at the time.
 */
import { GST_SLABS_BP, HSN_MAX_GOODS_CHAPTER } from "../config";
import { isNullLike } from "./text";

export type GstSlabStatus = "CURRENT" | "LEGACY" | "UNUSUAL";

export function gstSlabStatus(bp: number): GstSlabStatus {
  if (GST_SLABS_BP.CURRENT.includes(bp)) return "CURRENT";
  if (GST_SLABS_BP.LEGACY.includes(bp)) return "LEGACY";
  return "UNUSUAL";
}

/** Fractions that are unmistakably rates ("0.18"), as opposed to a percentage that happens to be < 1. */
const FRACTION_RATES = new Set([0.05, 0.12, 0.18, 0.28, 0.4]);

/**
 * "18%", "GST 18", "IGST@18.0%", 18, "0.18" -> 1800. Returns null when there is no
 * usable number or it is outside 0-100%. A bare number under 1 is read as a
 * percentage unless it is one of the well-known fractional forms.
 */
export function parseGstRate(raw: string | number | null | undefined): number | null {
  if (raw == null || isNullLike(raw)) return null;
  const text = String(raw);
  const m = text.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let pct = parseFloat(m[1]);
  const hasPercent = text.includes("%");
  if (!hasPercent && FRACTION_RATES.has(pct)) pct = pct * 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return Math.round(pct * 100);
}

/**
 * HSN digits only: "1905.31.00" -> "19053100". Accepts 4, 6 or 8 digits and a goods
 * chapter (01-97). 2-digit chapter-only values and SAC (99xxxx, services) are not
 * valid HSN for goods and are rejected.
 */
export function normalizeHsn(raw: string | number | null | undefined): string | null {
  if (raw == null || isNullLike(raw)) return null;
  const digits = String(raw).replace(/[\s.\-]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  if (![4, 6, 8].includes(digits.length)) return null;
  const chapter = parseInt(digits.slice(0, 2), 10);
  if (chapter < 1 || chapter > HSN_MAX_GOODS_CHAPTER) return null;
  return digits;
}

/** FSSAI licence / registration numbers are 14 digits and start with 1 (central) or 2 (state). */
export function normalizeFssai(raw: string | number | null | undefined): string | null {
  if (raw == null || isNullLike(raw)) return null;
  const digits = String(raw).replace(/[\s-]/g, "");
  return /^[12]\d{13}$/.test(digits) ? digits : null;
}

/** GSTIN structural check (15 chars). Structure only - it does not prove the GSTIN is registered. */
export function isValidGstin(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(raw.trim().toUpperCase());
}
