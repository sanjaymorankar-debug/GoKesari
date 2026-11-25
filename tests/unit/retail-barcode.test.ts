/**
 * Customer barcode search (docs/search-brand-barcode-favourites-2026-11): which codes are accepted,
 * and the plain reason when one is not.
 */
import { describe, expect, it } from "vitest";

import { gtinLookupForms, validateRetailBarcode } from "@/lib/retail-barcode";

describe("validateRetailBarcode", () => {
  it("accepts EAN-13, EAN-8, UPC-A and GTIN-14 with a valid check digit", () => {
    expect(validateRetailBarcode("8901063010017")).toMatchObject({ ok: true, format: "EAN-13", gtin14: "08901063010017" });
    expect(validateRetailBarcode("96385074")).toMatchObject({ ok: true, format: "EAN-8", gtin14: "00000096385074" });
    expect(validateRetailBarcode("036000291452")).toMatchObject({ ok: true, format: "UPC-A", gtin14: "00036000291452" });
    expect(validateRetailBarcode("18901063010014")).toMatchObject({ ok: true, format: "GTIN-14" });
  });

  it("ignores spaces and dashes as printed", () => {
    expect(validateRetailBarcode(" 8901063 010017 ")).toMatchObject({ ok: true, code: "8901063010017" });
    expect(validateRetailBarcode("890-1063-010017")).toMatchObject({ ok: true, code: "8901063010017" });
  });

  it("reports a wrong check digit, with the digit it should be", () => {
    const r = validateRetailBarcode("8901063010018");
    expect(r).toMatchObject({ ok: false, reason: "CHECK_DIGIT", expectedCheckDigit: 7 });
    if (!r.ok) expect(r.message).toMatch(/not valid/);
  });

  it("reports an empty code, letters and a wrong length", () => {
    expect(validateRetailBarcode("")).toMatchObject({ ok: false, reason: "EMPTY" });
    expect(validateRetailBarcode(null)).toMatchObject({ ok: false, reason: "EMPTY" });
    expect(validateRetailBarcode("ABC123456")).toMatchObject({ ok: false, reason: "NOT_DIGITS" });
    const short = validateRetailBarcode("1234567");
    expect(short).toMatchObject({ ok: false, reason: "WRONG_LENGTH" });
    if (!short.ok) expect(short.message).toContain("7 digits");
    expect(validateRetailBarcode("12345678901")).toMatchObject({ ok: false, reason: "WRONG_LENGTH" });
  });

  it("lists every stored form of the code for the lookup", () => {
    expect(gtinLookupForms("08901063010017", "8901063010017").sort()).toEqual(["08901063010017", "8901063010017"].sort());
    expect(gtinLookupForms("00036000291452", "036000291452")).toEqual(expect.arrayContaining(["00036000291452", "0036000291452", "036000291452"]));
    expect(gtinLookupForms("00000096385074", "96385074")).toEqual(expect.arrayContaining(["96385074", "00000096385074"]));
  });
});
