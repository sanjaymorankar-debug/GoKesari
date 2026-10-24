/**
 * Limits for prices, MRPs and stock counts, shared by the API schemas, the
 * services and the owner's forms so every screen refuses the same values.
 * Pure and client-safe. Every amount is an integer count of paise (see
 * lib/money.ts); stock is in whole sellable units.
 */
import { RUPEE_DECIMALS_MESSAGE, parseRupeeInput } from "./rupee-input";

/**
 * The smallest selling price: 1 paisa. A listing on sale at 0 would sell the
 * product for nothing (TC-CAT-004); "no price yet" is null, never 0.
 */
export const MIN_PRICE_PAISE = 1;

/** The field message for a price under MIN_PRICE_PAISE. */
export const PRICE_MIN_MESSAGE = "A price must be more than ₹0. Leave it empty for no price.";

/** The largest MRP the catalogue accepts, per unit: ₹10 lakh (TC-FLD-079). */
export const MAX_MRP_PAISE = 100_000_000;

/**
 * The largest selling price, per unit: the largest MRP, ₹10 lakh. ₹10 crore
 * used to be saved as a listing's price (TC-FLD-058/059).
 */
export const MAX_PRICE_PAISE = MAX_MRP_PAISE;
export const PRICE_MAX_MESSAGE = "A price can be at most ₹10,00,000.";

/** The largest stock count, low-stock threshold or reorder figure for one listing (TC-FLD-061/062/063). */
export const MAX_STOCK_UNITS = 1_000_000;
export const STOCK_MAX_MESSAGE = "Stock figures can be at most 10,00,000.";

export type PriceInput = { ok: true; paise: number } | { ok: false; error: string };

/**
 * What an owner types in a rupee price box: "58", "58.5", "58.50", "1,250".
 * Read as typed by the shared parseRupeeInput — more than two decimals is
 * refused rather than rounded ("10.555" used to be saved as 1056 paise,
 * TC-CAT-032) — then held to the price limits. Zero, negative and text are refused.
 */
export function parsePriceInput(raw: string): PriceInput {
  const read = parseRupeeInput(raw.replace(/[₹,\s]/g, ""));
  if (read.ok === true) {
    if (read.paise < MIN_PRICE_PAISE) return { ok: false, error: "Enter a price greater than 0." };
    if (read.paise > MAX_PRICE_PAISE) return { ok: false, error: PRICE_MAX_MESSAGE };
    return read;
  }
  if (read.ok === false && read.error === RUPEE_DECIMALS_MESSAGE) return { ok: false, error: "Use at most 2 decimals (paise), e.g. 10.55." };
  return { ok: false, error: "Enter a price greater than 0." };
}

/**
 * Whole-percent saving against the MRP, rounded down, for the "x% off" on a
 * product card (TC-CAT-008). Null when there is no MRP, the price is not below
 * it, or the saving is under 1 %.
 */
export function discountPercent(mrpPaise: number | null | undefined, pricePaise: number | null | undefined): number | null {
  if (mrpPaise == null || pricePaise == null || mrpPaise <= 0 || pricePaise >= mrpPaise) return null;
  const percent = Math.floor(((mrpPaise - pricePaise) * 100) / mrpPaise);
  return percent >= 1 ? percent : null;
}
