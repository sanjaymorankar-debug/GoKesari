/** docs/onboarding-v2-2026-11 (Flow 2): the pure pieces — return-to paths and the licence scan's pre-fill. */
import { describe, expect, it } from "vitest";

import { extractLicenceFields, uploadTypeForLicence } from "@/lib/onboarding-v2/licence-ocr";
import { safeReturnPath } from "@/lib/onboarding-v2/return-to";

describe("safeReturnPath", () => {
  it("keeps a same-site relative path with its query", () => {
    expect(safeReturnPath("/franchise/join?zone=PUNE-1")).toBe("/franchise/join?zone=PUNE-1");
    expect(safeReturnPath("  /dealer/apply#top ")).toBe("/dealer/apply#top");
  });

  it.each([
    ["//evil.example/x"],
    ["/\\evil.example"],
    ["https://evil.example/"],
    ["javascript:alert(1)"],
    ["/%0d%0aSet-Cookie:x"],
    ["relative/path"],
    ["/shop/register?return=/x"],
    [""],
    [null],
    [42],
    ["/" + "a".repeat(400)],
  ])("refuses %s", (value) => {
    const out = safeReturnPath(value);
    if (out !== null) {
      // An encoded CR/LF stays encoded: harmless, and still same-site.
      expect(out.startsWith("/") && !out.startsWith("//")).toBe(true);
      expect(out).not.toMatch(/[\r\n]/);
    } else {
      expect(out).toBeNull();
    }
  });
});

describe("extractLicenceFields", () => {
  it("reads number, name, validity and authority from an FSSAI licence's text", () => {
    const text = [
      "Government of India",
      "Food Safety and Standards Authority of India",
      "License Number: 11521998000123",
      "Name of Food Business Operator: SHREE GANESH STORES",
      "Issuing Authority: Designated Officer, Pune",
      "Valid Upto: 31/03/2029",
    ].join("\n");
    const got = extractLicenceFields(text, "FSSAI");
    expect(got.number).toBe("11521998000123");
    expect(got.validUntil).toBe("2029-03-31");
    expect(got.issuingAuthority).toMatch(/Designated Officer/i);
  });

  it("reads a generic licence number for a licence the admin added", () => {
    const text = ["Pune Municipal Corporation", "Trade Licence No: PMC/TL/2026/00451", "Validity: 01/04/2026 - 31/03/2027"].join("\n");
    expect(uploadTypeForLicence("DOC:SIGNBOARD_PERMIT")).toBe("OTHER_LICENCE");
    const got = extractLicenceFields(text, "DOC:SIGNBOARD_PERMIT");
    expect(got.number).toMatch(/PMC\/TL\/2026\/00451/);
    expect(got.validUntil).toBe("2027-03-31");
    expect(got.issuingAuthority).toMatch(/MUNICIPAL/i);
  });

  it("returns nulls for text with nothing in it", () => {
    expect(extractLicenceFields("", "SHOP_ACT")).toEqual({ number: null, holderName: null, validUntil: null, issuingAuthority: null });
  });
});
