/**
 * Stock and cart quantities in sellable units (D-95). Pure and client-safe, so
 * the owner's forms, the product card and the server use the same rules.
 *
 * A listing's stock (shop_products.online_stock / offline_stock) and a cart
 * line's quantity count the listing's sellable units: a 500 g pack, or one kg
 * of loose rice. Packaged goods are counted in whole units. Loose goods
 * (products.kind = LOOSE) keep up to three decimals: 2.5 kg of a 1 kg loose
 * listing is 2.5, and 250 g of it is 0.25. The stock ledger holds the same
 * figures ×1000 (milli-units), so three decimals is exactly what it can hold.
 */
import { MAX_STOCK_UNITS } from "./price-rules";

export type ProductKind = "PACKAGED" | "LOOSE";

/** Decimals a loose quantity may have: the stock ledger counts milli-units. */
export const STOCK_DECIMALS = 3;

/** The most one cart line holds — the API's limit per request, the product card's and a purchase list's. */
export const MAX_CART_LINE_QUANTITY = 99;

/** A quantity rounded to what the database keeps (0.1 + 0.2 → 0.3). */
export function roundStock(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** True when the value has at most three decimals (2.5, 0.25, 0.125 — not 0.0001). */
export function hasMilliPrecision(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6;
}

/** "2.5", "100", "0.125" — at most three decimals, no trailing zeros. */
export function formatStock(value: number): string {
  return String(roundStock(value));
}

/** Sellable units → milli-units, as the stock ledger counts them. */
export function stockToMilli(value: number): number {
  return Math.round(value * 1000);
}

/**
 * Why `value` cannot be a listing's stock, or null when it can: 0 to
 * MAX_STOCK_UNITS, whole for packaged goods, up to three decimals for loose.
 */
export function stockQuantityProblem(value: number, kind: ProductKind, field = "Stock"): string | null {
  if (!Number.isFinite(value) || value < 0 || value > MAX_STOCK_UNITS) {
    return `${field} must be from 0 to ${MAX_STOCK_UNITS.toLocaleString("en-IN")}.`;
  }
  if (kind === "LOOSE") {
    return hasMilliPrecision(value) ? null : `${field} can have at most ${STOCK_DECIMALS} decimals (for example 2.5 or 0.25).`;
  }
  return Number.isInteger(value) ? null : `${field} must be a whole number for a packaged product (loose goods can have decimals).`;
}

export interface CartQuantityProduct {
  kind: ProductKind;
  /** Size of one sellable unit in milli of products.unit (1 kg → 1000, 500 g listed in g → 500000). */
  unitSizeMilli: number;
}

/**
 * Why `quantity` cannot be a cart line, or null when it can. Packaged goods:
 * a whole number from 1 to 99. Loose goods: more than 0 and at most 99, with
 * up to three decimals and a whole number of milli of the product's unit
 * (0.25 of a 1 kg listing is 250 g; 0.0005 of it is not a quantity).
 */
export function cartQuantityProblem(quantity: number, product: CartQuantityProduct, { allowZero = false } = {}): string | null {
  if (allowZero && quantity === 0) return null;
  if (product.kind === "LOOSE") {
    const ok =
      Number.isFinite(quantity) &&
      quantity > 0 &&
      quantity <= MAX_CART_LINE_QUANTITY &&
      hasMilliPrecision(quantity) &&
      (stockToMilli(quantity) * product.unitSizeMilli) % 1000 === 0;
    return ok ? null : `Quantity must be more than 0 and at most ${MAX_CART_LINE_QUANTITY}, with at most ${STOCK_DECIMALS} decimals (for example 0.25 or 1.5).`;
  }
  return Number.isInteger(quantity) && quantity >= (allowZero ? 0 : 1) && quantity <= MAX_CART_LINE_QUANTITY
    ? null
    : `Quantity must be a whole number from ${allowZero ? 0 : 1} to ${MAX_CART_LINE_QUANTITY}.`;
}

/** A cart quantity in sellable units → the order line's quantity in milli of the product's unit. */
export function quantityToMilli(quantity: number, unitSizeMilli: number): number {
  return Math.round((stockToMilli(quantity) * unitSizeMilli) / 1000);
}

/**
 * An order line's quantity (milli of the product's unit) → the sellable units
 * it takes from or puts back into stock. Loose goods: exactly (to three
 * decimals). Packaged goods: whole units, rounded the way the caller always did
 * (cancellations and substitutes round, returns of unopened goods floor,
 * subscription deliveries ceil).
 */
export function milliToStockUnits(
  quantityMilli: number,
  unitSizeMilli: number,
  kind: ProductKind,
  packaged: "round" | "floor" | "ceil" = "round",
): number {
  const units = quantityMilli / Math.max(1, unitSizeMilli);
  if (kind === "LOOSE") return roundStock(units);
  return Math[packaged](units);
}

/** Loose goods by weight or volume step in 250 g / 250 ml; the base is that amount in milli of the unit. */
const QUARTER_BASE: Record<string, number> = { kg: 250, L: 250, g: 250_000, ml: 250_000 };

/**
 * The − / + step of a cart line in sellable units: 1 for packaged goods; for a
 * loose good sold by weight or volume, 250 g / 250 ml when that is at most one
 * unit and a whole number of milli-units (0.25 of a 1 kg listing, 0.5 of a
 * 500 g one, 1 of a 250 g one); otherwise 1.
 */
export function cartQuantityStep(product: CartQuantityProduct & { unit: string }): number {
  if (product.kind !== "LOOSE") return 1;
  const base = QUARTER_BASE[product.unit];
  if (!base || product.unitSizeMilli <= base) return 1;
  const step = base / product.unitSizeMilli;
  return hasMilliPrecision(step) ? roundStock(step) : 1;
}
