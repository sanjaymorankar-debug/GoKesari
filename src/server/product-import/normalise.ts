/**
 * Value normalisation for the bulk product upload (docs/product-import-2026-10).
 *
 * Every function is pure and total: it returns a value, or null when the cell
 * is blank, or `{ invalid }` (via the `Parsed` type) when there is something
 * in the cell that cannot be read — the caller keeps the raw text and adds a
 * warning. Nothing here ever throws on user data.
 */
import { analyzeGtin } from "@/server/pmd/normalize/identifiers";
import { parseGstRate, normalizeHsn } from "@/server/pmd/normalize/tax";
import { hasMilliPrecision, roundStock } from "@/lib/stock-quantity";

export type Parsed<T> = { ok: true; value: T } | { ok: false; raw: string } | null;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = (raw: string): Parsed<never> => ({ ok: false, raw });

/** Trimmed text with inner runs of whitespace collapsed; null when blank. */
export function text(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).replace(/ /g, " ").replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/**
 * A number written the Indian way or any other way: "1,299.00", "₹1299",
 * "Rs. 1,29,999", "INR 99/-", " 42 ". Negative numbers are kept (the caller
 * decides whether they are allowed). Ranges and free text are invalid.
 */
export function number(raw: unknown): Parsed<number> {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? ok(raw) : bad(String(raw));
  const original = String(raw).trim();
  if (!original) return null;
  let s = original
    .replace(/^\s*(?:rs\.?|inr|rupees?|₹)\s*/i, "")
    .replace(/\s*\/-\s*$/, "")
    .replace(/\s+/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  }
  // Indian (1,29,999.50) and international (129,999.50) grouping both just drop their commas.
  if (!/^(?:\d{1,3}(?:,\d{2,3})*|\d+)(?:\.\d+)?$/.test(s)) return bad(original);
  const value = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(value)) return bad(original);
  return ok(negative ? -value : value);
}

/** Rupees → integer paise. Negative amounts are invalid. */
export function paise(raw: unknown): Parsed<number> {
  const n = number(raw);
  if (!n || !n.ok) return n;
  if (n.value < 0) return bad(String(raw));
  return ok(Math.round(n.value * 100));
}

/** A whole number ≥ 0 (stock, order limits, piece counts). "12.0" is 12; "12.5" and "-3" are invalid. */
/**
 * A stock quantity: 0 or more, with at most three decimals (D-95: 2.5 kg of a
 * loose good). Whether a fraction may be applied depends on the product
 * (packaged goods stay whole) and is decided when the row is committed.
 */
export function stockQuantity(raw: unknown): Parsed<number> {
  const n = number(raw);
  if (!n || !n.ok) return n;
  if (n.value < 0 || !hasMilliPrecision(n.value)) return bad(String(raw));
  return ok(roundStock(n.value));
}

export function wholeNumber(raw: unknown): Parsed<number> {
  const n = number(raw);
  if (!n || !n.ok) return n;
  if (n.value < 0 || !Number.isInteger(n.value)) return bad(String(raw));
  return ok(n.value);
}

/* ------------------------------------------------------------------ dates */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Excel's serial day number (1900 system, with its 29-Feb-1900 bug) → yyyy-mm-dd. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 120_000) return null;
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * yyyy-mm-dd from: a Date, an Excel serial number, ISO (2026-10-15, with or
 * without a time), dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (Indian day-first) and
 * "15 Oct 2026" / "15-Oct-26".
 */
export function date(raw: unknown): Parsed<string> {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? bad(String(raw)) : ok(raw.toISOString().slice(0, 10));
  if (typeof raw === "number") {
    const iso = excelSerialToIso(raw);
    return iso ? ok(iso) : bad(String(raw));
  }
  const s = String(raw).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) {
    const iso = isoDate(+m[1], +m[2], +m[3]);
    return iso ? ok(iso) : bad(s);
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const iso = isoDate(year, +m[2], +m[1]);
    return iso ? ok(iso) : bad(s);
  }
  m = /^(\d{1,2})[\s/-]([a-z]{3,4})[a-z]*[\s/,-]+(\d{2}|\d{4})$/i.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const iso = isoDate(year, MONTHS[m[2].toLowerCase()], +m[1]);
    return iso ? ok(iso) : bad(s);
  }
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const iso = excelSerialToIso(Number(s));
    return iso ? ok(iso) : bad(s);
  }
  return bad(s);
}

/* --------------------------------------------------------------- booleans */

const TRUE_WORDS = new Set(["yes", "y", "true", "t", "1", "available"]);
const FALSE_WORDS = new Set(["no", "n", "false", "f", "0", "not available"]);

export function bool(raw: unknown): Parsed<boolean> {
  if (raw == null) return null;
  if (typeof raw === "boolean") return ok(raw);
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (TRUE_WORDS.has(s)) return ok(true);
  if (FALSE_WORDS.has(s)) return ok(false);
  return bad(String(raw));
}

/* ------------------------------------------------------------------ units */

type UnitRow = [pattern: RegExp, factor: number, code: string];

const LENGTH_TO_CM: UnitRow[] = [
  [/^(?:mm|millimet(?:er|re)s?)$/, 0.1, "mm"],
  [/^(?:cm|cms|centimet(?:er|re)s?)$/, 1, "cm"],
  [/^(?:m|mtr|mtrs|met(?:er|re)s?)$/, 100, "m"],
  [/^(?:in|inch|inches|")$/, 2.54, "in"],
  [/^(?:ft|foot|feet|')$/, 30.48, "ft"],
];

const WEIGHT_TO_G: UnitRow[] = [
  [/^(?:mg|milligrams?|milligrammes?)$/, 0.001, "mg"],
  [/^(?:g|gm|gms|grams?|grammes?)$/, 1, "g"],
  [/^(?:kg|kgs|kilo|kilos|kilograms?|kilogrammes?)$/, 1000, "kg"],
  [/^(?:lb|lbs|pounds?)$/, 453.59237, "lb"],
  [/^(?:oz|ounces?)$/, 28.349523125, "oz"],
];

function findUnit(table: UnitRow[], unit: string | null): UnitRow | null {
  if (!unit) return null;
  const u = unit.trim().toLowerCase().replace(/\.$/, "");
  return table.find(([pattern]) => pattern.test(u)) ?? null;
}

/** The canonical short form of a length or weight unit ("Centimetres" → "cm", "Kilograms" → "kg"); null if unknown. */
export function unitCode(unit: string | null): string | null {
  return (findUnit(LENGTH_TO_CM, unit) ?? findUnit(WEIGHT_TO_G, unit))?.[2] ?? null;
}

/**
 * A measurement in a target unit. `value` may carry its own unit ("12 cm",
 * "1.5kg"); otherwise `unit` (the template's separate unit column) applies,
 * and with neither the value is taken as already in the target unit.
 */
function measure(value: unknown, unit: unknown, table: UnitRow[]): Parsed<number> {
  if (value == null || String(value).trim() === "") return null;
  let unitText = text(unit);
  let numeric: unknown = value;
  if (typeof value === "string") {
    const m = /^\s*([0-9.,]+)\s*([a-zA-Z"']+\.?)\s*$/.exec(value);
    if (m) {
      numeric = m[1];
      unitText = m[2];
    }
  }
  const n = number(numeric);
  if (!n || !n.ok || n.value < 0) return bad(`${String(value)}${unitText ? ` ${unitText}` : ""}`);
  if (!unitText) return ok(round2(n.value));
  const found = findUnit(table, unitText);
  if (!found) return bad(`${String(value)} ${unitText}`);
  return ok(round2(n.value * found[1]));
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export const lengthCm = (value: unknown, unit: unknown) => measure(value, unit, LENGTH_TO_CM);
export const weightG = (value: unknown, unit: unknown) => measure(value, unit, WEIGHT_TO_G);

/* -------------------------------------------------------------- identifiers */

export const BARCODE_TYPES = ["EAN", "UPC", "GTIN", "ISBN", "ASIN", "GTIN_EXEMPT", "OTHER"] as const;
export type BarcodeType = (typeof BARCODE_TYPES)[number];

/** The template's Product Id Type ("EAN", "upc", "GTIN Exempt"…) as one of BARCODE_TYPES. */
export function barcodeType(raw: unknown): BarcodeType | null {
  const s = text(raw)?.toUpperCase().replace(/[\s-]+/g, "_");
  if (!s) return null;
  if (s.includes("EXEMPT")) return "GTIN_EXEMPT";
  if (s.startsWith("EAN")) return "EAN";
  if (s.startsWith("UPC")) return "UPC";
  if (s.startsWith("GTIN")) return "GTIN";
  if (s.startsWith("ISBN")) return "ISBN";
  if (s.startsWith("ASIN")) return "ASIN";
  return "OTHER";
}

/**
 * A barcode as text (a number cell loses nothing: 8901234567890 is exact in a
 * double) and, when it is shaped like a GTIN, its canonical 14 digits.
 */
export function barcode(raw: unknown): { value: string; gtin14: string | null; checkDigitValid: boolean } | null {
  if (raw == null) return null;
  const value = typeof raw === "number" ? String(raw) : text(raw);
  if (!value) return null;
  const info = analyzeGtin(value);
  return { value, gtin14: info?.gtin14 ?? null, checkDigitValid: info?.checkDigitValid ?? false };
}

/** The products.gtin form (digits only, as printed: GTIN-8/12/13/14 without padding). */
export function gtinDigits(gtin14: string): string {
  if (gtin14.startsWith("000000")) return gtin14.slice(6); // GTIN-8
  if (gtin14.startsWith("00")) return gtin14.slice(2); // UPC-A (12)
  if (gtin14.startsWith("0")) return gtin14.slice(1); // EAN-13
  return gtin14;
}

export const hsn = (raw: unknown): Parsed<string> => {
  const t = text(raw);
  if (!t) return null;
  const v = normalizeHsn(t);
  return v ? ok(v) : bad(t);
};

/** GST % ("18", "18%", "0.18") → basis points. */
export const gstRateBp = (raw: unknown): Parsed<number> => {
  const t = text(raw);
  if (!t) return null;
  const v = parseGstRate(t);
  return v == null ? bad(t) : ok(v);
};

/** Free text compared for matching: lower case, letters and digits only. */
export function matchKey(raw: string | null | undefined): string {
  return (raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
