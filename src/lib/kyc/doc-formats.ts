/**
 * Local format checks for the five seller documents, run before any paid
 * verification call (seller verification, Part 2.2). A number that fails here
 * never reaches the vendor, so a typo costs nothing.
 *
 * Builds on the parsers in lib/shop-identity.ts (registration already uses
 * them) and adds what a paid call needs on top: the PAN holder-type
 * character, the GSTIN checksum, and the FSSAI number. Pure functions, safe to
 * import in client components for instant form feedback.
 */
import {
  parseGstin,
  parsePanNumber,
  parseShopActNumber,
  parseUdyamNumber,
  type ParseResult,
} from "@/lib/shop-identity";

export const SELLER_DOC_TYPES = ["PAN", "GSTIN", "UDYAM", "FSSAI", "SHOP_ACT"] as const;
export type SellerDocType = (typeof SELLER_DOC_TYPES)[number];

/**
 * Lifecycle of one document for one shop. NOT_SUBMITTED is what a shop has
 * before it sends a number; PENDING means submitted and waiting on the
 * vendor (including when the vendor is down — the seller is never failed for
 * that); MANUAL_REVIEW means an admin must decide.
 */
export const SELLER_VERIFICATION_STATUSES = [
  "NOT_SUBMITTED",
  "PENDING",
  "VERIFIED",
  "FAILED",
  "MANUAL_REVIEW",
  "EXPIRED",
] as const;
export type SellerVerificationStatus = (typeof SELLER_VERIFICATION_STATUSES)[number];

export const SELLER_DOC_LABELS: Record<SellerDocType, string> = {
  PAN: "PAN",
  GSTIN: "GST number (GSTIN)",
  UDYAM: "Udyam registration",
  FSSAI: "FSSAI licence / registration",
  SHOP_ACT: "Shop Act (Shops & Establishments) certificate",
};

/**
 * The 4th character of a PAN says who holds it. Used to tell a personal PAN
 * (proprietor) from a firm's or company's, which changes whose name it should
 * match.
 */
export const PAN_HOLDER_TYPES = {
  P: "Individual",
  C: "Company",
  H: "Hindu Undivided Family",
  F: "Firm / LLP",
  A: "Association of Persons",
  T: "Trust",
  B: "Body of Individuals",
  L: "Local authority",
  J: "Artificial juridical person",
  G: "Government",
} as const;
export type PanHolderType = keyof typeof PAN_HOLDER_TYPES;

export interface ParsedDocNumber {
  docType: SellerDocType;
  /** Canonical form sent to the vendor and encrypted at rest. Never logged or shown. */
  normalized: string;
  /** Safe to display and log. */
  masked: string;
  /** PAN only (also the PAN inside a GSTIN): the holder-type letter. */
  panHolderType?: PanHolderType;
  /** GSTIN only: the two-digit state code and the PAN embedded in it. */
  gstStateCode?: string;
  gstEmbeddedPan?: string;
}

const GSTIN_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * GSTIN check character (15th): a mod-36 Luhn variant over the first 14.
 * Each character's index is multiplied by 1 or 2 alternately, and the product
 * contributes its base-36 quotient plus remainder.
 */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = GSTIN_CHARSET.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARSET[(36 - (sum % 36)) % 36];
}

/** State and UT codes used in GSTINs (01–38), plus 97 (other territory) and 99 (centre jurisdiction). */
function isKnownGstStateCode(code: string): boolean {
  const n = Number(code);
  return (n >= 1 && n <= 38) || n === 97 || n === 99;
}

function maskTail(value: string, visible: number, keepHead = 0): string {
  const head = value.slice(0, keepHead);
  const tail = value.slice(-visible);
  return head + "X".repeat(Math.max(0, value.length - keepHead - visible)) + tail;
}

function panHolderType(pan: string): PanHolderType | null {
  const letter = pan[3];
  return letter in PAN_HOLDER_TYPES ? (letter as PanHolderType) : null;
}

export function parseSellerPan(raw: string): ParseResult<ParsedDocNumber> {
  const parsed = parsePanNumber(raw);
  if (!parsed.ok) return parsed;
  const holder = panHolderType(parsed.value);
  if (!holder) {
    return {
      ok: false,
      error: "The 4th letter of a PAN shows the holder type (P, C, H, F, A, T, B, L, J or G). Please check the number.",
    };
  }
  return {
    ok: true,
    value: {
      docType: "PAN",
      normalized: parsed.value,
      masked: maskTail(parsed.value, 4),
      panHolderType: holder,
    },
  };
}

export function parseSellerGstin(raw: string): ParseResult<ParsedDocNumber> {
  const parsed = parseGstin(raw.replace(/\s+/g, ""));
  if (!parsed.ok) return parsed;
  const gstin = parsed.value;
  const stateCode = gstin.slice(0, 2);
  if (!isKnownGstStateCode(stateCode)) {
    return { ok: false, error: "The first two digits of a GSTIN are the state code. Please check the number." };
  }
  const embeddedPan = gstin.slice(2, 12);
  const holder = panHolderType(embeddedPan);
  if (!holder) {
    return { ok: false, error: "Characters 3–12 of a GSTIN are the business's PAN, and that part is not valid." };
  }
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) {
    return { ok: false, error: "This GSTIN fails its check digit — one character is probably mistyped." };
  }
  return {
    ok: true,
    value: {
      docType: "GSTIN",
      normalized: gstin,
      masked: maskTail(gstin, 3, 2),
      panHolderType: holder,
      gstStateCode: stateCode,
      gstEmbeddedPan: embeddedPan,
    },
  };
}

/**
 * Udyam only — the vendor APIs look up the current UDYAM-XX-00-0000000 form.
 * An old Udyog Aadhaar number (accepted at registration for duplicate
 * checks) is refused here with a pointer to the new number.
 */
export function parseSellerUdyam(raw: string): ParseResult<ParsedDocNumber> {
  const parsed = parseUdyamNumber(raw);
  if (!parsed.ok) return parsed;
  if (!parsed.value.startsWith("UDYAM-")) {
    return {
      ok: false,
      error: "Old Udyog Aadhaar numbers can't be verified online. Enter your Udyam number (UDYAM-XX-00-0000000) from udyamregistration.gov.in.",
    };
  }
  return {
    ok: true,
    value: { docType: "UDYAM", normalized: parsed.value, masked: maskTail(parsed.value, 4, 9) },
  };
}

/** FSSAI licence and registration numbers are 14 digits. */
export function parseSellerFssai(raw: string): ParseResult<ParsedDocNumber> {
  const value = raw.replace(/[\s\-/.]/g, "");
  if (!/^\d{14}$/.test(value)) {
    return { ok: false, error: "An FSSAI licence or registration number is exactly 14 digits." };
  }
  return { ok: true, value: { docType: "FSSAI", normalized: value, masked: maskTail(value, 4) } };
}

/**
 * Shop Act numbers have no single format (they differ by state and by city),
 * so this is the same shape check registration uses. The matching key —
 * letters and digits only — is what gets verified and stored.
 */
export function parseSellerShopAct(raw: string): ParseResult<ParsedDocNumber> {
  const parsed = parseShopActNumber(raw);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: { docType: "SHOP_ACT", normalized: parsed.value.key, masked: maskTail(parsed.value.key, 4) },
  };
}

const PARSERS: Record<SellerDocType, (raw: string) => ParseResult<ParsedDocNumber>> = {
  PAN: parseSellerPan,
  GSTIN: parseSellerGstin,
  UDYAM: parseSellerUdyam,
  FSSAI: parseSellerFssai,
  SHOP_ACT: parseSellerShopAct,
};

export function parseSellerDocNumber(docType: SellerDocType, raw: string): ParseResult<ParsedDocNumber> {
  if (!raw || !raw.trim()) return { ok: false, error: `Enter your ${SELLER_DOC_LABELS[docType]} number.` };
  return PARSERS[docType](raw);
}
