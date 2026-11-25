/**
 * Customer barcode search (docs/search-brand-barcode-favourites-2026-11): which codes a customer may
 * look up, checked before anything is read. Pure — used by the API and by the search box's scan sheet.
 *
 * Accepted: EAN-8 (8 digits), UPC-A (12), EAN-13 (13) and GTIN-14 (14), each with a valid GS1 check
 * digit. Anything else gets a clear reason, so a mistyped digit is reported as a mistyped digit and not
 * as "product not found" (the shop flow's cleanBarcode accepts any 6+ characters and never says so).
 */
import { gs1CheckDigit } from "@/server/pmd/normalize/identifiers";

export type RetailBarcodeFormat = "EAN-8" | "UPC-A" | "EAN-13" | "GTIN-14";

export type RetailBarcodeResult =
  | {
      ok: true;
      /** The digits as scanned or typed (spaces and dashes removed). */
      code: string;
      format: RetailBarcodeFormat;
      /** Zero-padded GTIN-14: the form every length of the same item compares equal in. */
      gtin14: string;
    }
  | {
      ok: false;
      reason: "EMPTY" | "NOT_DIGITS" | "WRONG_LENGTH" | "CHECK_DIGIT";
      message: string;
      /** For CHECK_DIGIT: the digit the code should end with. */
      expectedCheckDigit?: number;
    };

const FORMAT_BY_LENGTH: Record<number, RetailBarcodeFormat> = { 8: "EAN-8", 12: "UPC-A", 13: "EAN-13", 14: "GTIN-14" };

export function validateRetailBarcode(raw: string | null | undefined): RetailBarcodeResult {
  const code = String(raw ?? "").replace(/[\s-]/g, "");
  if (!code) return { ok: false, reason: "EMPTY", message: "Scan a barcode or type the number printed under it." };
  if (!/^\d+$/.test(code)) {
    return { ok: false, reason: "NOT_DIGITS", message: "A product barcode has digits only. Check the number and try again." };
  }
  const format = FORMAT_BY_LENGTH[code.length];
  if (!format) {
    return {
      ok: false,
      reason: "WRONG_LENGTH",
      message: `This number has ${code.length} digits. A product barcode has 8, 12, 13 or 14 digits.`,
    };
  }
  const expected = gs1CheckDigit(code.slice(0, -1));
  if (expected !== code.charCodeAt(code.length - 1) - 48) {
    return {
      ok: false,
      reason: "CHECK_DIGIT",
      message: "This barcode number is not valid — a digit may be mistyped. Check the number under the bars and try again.",
      expectedCheckDigit: expected,
    };
  }
  return { ok: true, code, format, gtin14: code.padStart(14, "0") };
}

/** Every stored form of a GTIN-14 (GTIN-14, EAN-13, UPC-A, EAN-8 as scanned), for matching `products.gtin`. */
export function gtinLookupForms(gtin14: string, scanned: string): string[] {
  const forms = new Set<string>([gtin14, scanned]);
  if (gtin14.startsWith("0")) forms.add(gtin14.slice(1));
  if (gtin14.startsWith("00")) forms.add(gtin14.slice(2));
  if (gtin14.startsWith("000000")) forms.add(gtin14.slice(6));
  return [...forms];
}
