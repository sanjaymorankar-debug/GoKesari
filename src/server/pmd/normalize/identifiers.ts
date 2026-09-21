/**
 * Product identifiers: GTIN / EAN / UPC / ISBN validation and canonicalisation,
 * plus the looser MPN / model / SKU keys.
 *
 * Canonical form for every GTIN family member is the zero-padded GTIN-14: an
 * EAN-13, a UPC-A and a GTIN-14 for the same item then compare equal as strings.
 * (GoKesari's existing products.gtin stores the digits as scanned, so a UPC-A and
 * its EAN-13 form would not collide there - the platform must not inherit that.)
 *
 * A code is only allowed to *drive a match* when its check digit is valid and it
 * is not in a restricted-circulation range. Crowdsourced sources carry plenty of
 * invalid or store-internal codes; treating those as global identity is how two
 * unrelated products get merged.
 */
import type { GtinInfo } from "../types";

/** GS1 mod-10 check digit for a code body (everything but the check digit). */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  // Weight 3 on the rightmost body digit, alternating 1, 3, 1...
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += (body.charCodeAt(i) - 48) * w;
  }
  return (10 - (sum % 10)) % 10;
}

export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  return gs1CheckDigit(digits.slice(0, -1)) === digits.charCodeAt(digits.length - 1) - 48;
}

export function isbn10Valid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === "X" ? 10 : s.charCodeAt(i) - 48) * (10 - i);
  return sum % 11 === 0;
}

export function isbn10To13(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!isbn10Valid(s)) return null;
  const body = "978" + s.slice(0, 9);
  return body + gs1CheckDigit(body);
}

const FORMATS: Record<number, GtinInfo["format"]> = { 8: "GTIN-8", 12: "GTIN-12", 13: "GTIN-13", 14: "GTIN-14" };

function restrictedRange(gtin14: string): GtinInfo["restricted"] | undefined {
  // Restricted ranges are defined on the GTIN-13 prefix. For a GTIN-14 the indicator
  // digit (first) is dropped; GTIN-8 has no equivalent restricted list here.
  const g13 = gtin14.slice(1);
  if (g13.startsWith("000000")) return undefined;
  const p3 = parseInt(g13.slice(0, 3), 10);
  if (p3 >= 20 && p3 <= 29) return "IN_STORE";
  if (p3 >= 40 && p3 <= 49) return "IN_STORE";
  if (p3 >= 200 && p3 <= 299) return "IN_STORE";
  if (p3 >= 50 && p3 <= 59) return "COUPON";
  if (p3 === 977) return "SERIAL";
  if (p3 === 980 || (p3 >= 981 && p3 <= 984) || (p3 >= 990 && p3 <= 999)) return "COUPON";
  return undefined;
}

/**
 * Analyses a barcode-ish string. Returns null when it is not shaped like a GTIN
 * at all (wrong length, non-digits, all one repeated digit) - the caller then
 * keeps it as an opaque source code rather than an identifier.
 */
export function analyzeGtin(raw: string | number | null | undefined): GtinInfo | null {
  if (raw == null) return null;
  const original = String(raw).trim();
  let digits = original.replace(/[\s-]/g, "");

  // ISBN-10 arrives as 10 digits (last may be X); promote to ISBN-13 so it is a real GTIN.
  if (/^\d{9}[\dX]$/i.test(digits)) {
    const isbn13 = isbn10To13(digits);
    if (!isbn13) return null;
    digits = isbn13;
  }
  if (!/^\d+$/.test(digits) || !FORMATS[digits.length]) return null;
  if (/^(\d)\1+$/.test(digits)) return null;

  const gtin14 = digits.padStart(14, "0");
  const checkDigitValid = gtinCheckDigitValid(digits);
  const restricted = restrictedRange(gtin14);
  const isbn13 = digits.length === 13 && /^97[89]/.test(digits) && checkDigitValid ? digits : undefined;

  return {
    gtin14,
    format: FORMATS[digits.length],
    original,
    checkDigitValid,
    ...(restricted ? { restricted } : {}),
    usableForMatching: checkDigitValid && !restricted,
    ...(isbn13 ? { isbn13 } : {}),
  };
}

/** EAN-13 display form of a canonical GTIN-14 (null if it needs the indicator digit). */
export function toEan13(gtin14: string): string | null {
  return gtin14.startsWith("0") ? gtin14.slice(1) : null;
}

/** UPC-A display form of a canonical GTIN-14 (null if it is not a UPC-range code). */
export function toUpcA(gtin14: string): string | null {
  return gtin14.startsWith("00") ? gtin14.slice(2) : null;
}

/* --------------------------------------------- MPN / model / SKU style keys */

const JUNK_KEYS = /^(NA|NONE|NULL|NIL|UNKNOWN|NOTAVAILABLE|TBD|TEST|NOMODEL|GENERIC|0+)$/;

/**
 * Identity key for manufacturer part numbers, model numbers and SKUs: upper-case
 * alphanumerics only, so "SM-S918B/DS" and "sm s918b ds" compare equal. Returns
 * null for placeholders and anything too short to identify a product.
 */
export function normalizeAlnumKey(raw: string | number | null | undefined): { key: string; original: string } | null {
  if (raw == null) return null;
  const original = String(raw).trim();
  const key = original.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key.length < 3 || JUNK_KEYS.test(key)) return null;
  return { key, original };
}
