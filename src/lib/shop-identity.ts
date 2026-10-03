/**
 * Business identifiers used to stop the same shop being registered twice
 * (see server/services/shop-duplicates.ts): the Shop Act / Gumasta licence,
 * PAN, and Udyam / Udyog Aadhaar numbers.
 *
 * Every value is normalised before it is stored or compared, so a check
 * compares like with like — "ab 12/34" and "AB-1234" are the same licence.
 * Pure functions, safe to import in client components: nothing here touches
 * crypto or the database. The PAN itself is never stored in plaintext — see
 * panBlindIndex() in lib/pan-crypto.ts for how two PANs are compared.
 */

export type ShopIdentifierField = "shopActNumber" | "panNumber" | "udyamNumber";

export const SHOP_IDENTIFIER_FIELDS: readonly ShopIdentifierField[] = [
  "shopActNumber",
  "panNumber",
  "udyamNumber",
];

export const SHOP_IDENTIFIER_LABELS: Record<ShopIdentifierField, string> = {
  shopActNumber: "Shop Act licence number",
  panNumber: "PAN number",
  udyamNumber: "Udyam number",
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ShopActNumber {
  /** As entered, trimmed and uppercased, spacing collapsed — for display. */
  display: string;
  /** Letters and digits only — what duplicates are matched on. */
  key: string;
}

/**
 * What owners type when they have no licence. Stored as a real number, every
 * one of them would collide with every other shop that typed the same thing.
 */
const PLACEHOLDER_KEYS = new Set([
  "NA",
  "NIL",
  "NULL",
  "NONE",
  "NOTAPPLICABLE",
  "APPLIED",
  "APPLIEDFOR",
  "PENDING",
  "TEST",
  "UNKNOWN",
]);

/** Letters, digits and the separators licence numbers are printed with. */
const SHOP_ACT_ALLOWED = /^[A-Za-z0-9 \-/.,()]+$/;

/**
 * Shop Act / Gumasta registration numbers have no single national format —
 * they vary by municipality and by which Act issued them — so this checks
 * shape, not format: at least five letters/digits including a digit, and
 * not a placeholder.
 */
export function parseShopActNumber(raw: string): ParseResult<ShopActNumber> {
  const display = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!SHOP_ACT_ALLOWED.test(display)) {
    return {
      ok: false,
      error: "Use English letters and digits only, as printed on the certificate.",
    };
  }
  const key = display.replace(/[^A-Z0-9]/g, "");
  if (
    key.length < 5 ||
    key.length > 40 ||
    !/\d/.test(key) ||
    PLACEHOLDER_KEYS.has(key) ||
    /^(.)\1+$/.test(key)
  ) {
    return {
      ok: false,
      error:
        "Enter the licence number exactly as printed on your Shop Act (Gumasta) certificate, or leave this blank.",
    };
  }
  return { ok: true, value: { display, key } };
}

const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** PAN, with spaces/hyphens/slashes/dots removed and uppercased (AAAAA9999A). */
export function parsePanNumber(raw: string): ParseResult<string> {
  const value = raw.toUpperCase().replace(/[\s\-/.]/g, "");
  if (!PAN_PATTERN.test(value)) {
    return { ok: false, error: "PAN must be 10 characters in the format AAAAA9999A." };
  }
  return { ok: true, value };
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** GSTIN, trimmed and uppercased (27ABCDE1234F1Z5). */
export function parseGstin(raw: string): ParseResult<string> {
  const value = raw.trim().toUpperCase();
  if (!GSTIN_PATTERN.test(value)) {
    return { ok: false, error: "GST number must be 15 characters, e.g. 27ABCDE1234F1Z5." };
  }
  return { ok: true, value };
}

/** Shown when none of the business identifiers is filled in at registration. */
export const IDENTIFIER_REQUIRED_MESSAGE =
  "Please enter at least one of PAN, Udyam Aadhaar, GST or Shop Act number.";

const UDYAM_PATTERN = /^UDYAM([A-Z]{2})(\d{2})(\d{7})$/;
/** Pre-2020 Udyog Aadhaar Memorandum number: state, district, a letter, 7 digits. */
const UDYOG_AADHAAR_PATTERN = /^[A-Z]{2}\d{2}[A-Z]\d{7}$/;

/**
 * Udyam registration number, stored as UDYAM-XX-00-0000000; an old Udyog
 * Aadhaar number is stored as its 12 characters (e.g. MH26A0012345).
 *
 * A bare 12-digit number is refused on purpose: it cannot be told apart from
 * a personal Aadhaar number, which the platform must not collect.
 */
export function parseUdyamNumber(raw: string): ParseResult<string> {
  const value = raw.toUpperCase().replace(/[\s\-/.]/g, "");
  const udyam = UDYAM_PATTERN.exec(value);
  if (udyam) return { ok: true, value: `UDYAM-${udyam[1]}-${udyam[2]}-${udyam[3]}` };
  if (UDYOG_AADHAAR_PATTERN.test(value)) return { ok: true, value };
  if (/^\d{12}$/.test(value)) {
    return {
      ok: false,
      error:
        "That looks like a personal Aadhaar number. Enter your Udyam number (UDYAM-XX-00-0000000) or old Udyog Aadhaar number (e.g. MH26A0012345) instead.",
    };
  }
  return {
    ok: false,
    error:
      "Enter a Udyam number like UDYAM-MH-26-0012345, or an old Udyog Aadhaar number like MH26A0012345.",
  };
}

/**
 * Loose comparison key for shop names and addresses: case, spacing and
 * punctuation ignored, letters of any script kept (with their combining
 * marks, so Devanagari vowel signs still count). Used to decide whether two
 * registrations are the same shop at the same place.
 */
export function looseKey(value: string | null | undefined): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
}

/** "…4470" — the last few characters only, for messages that confirm a match. */
export function maskTail(value: string, visible = 4): string {
  return `…${value.slice(-visible)}`;
}
