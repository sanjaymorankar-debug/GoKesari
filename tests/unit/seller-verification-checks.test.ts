/**
 * Seller verification, Part 3: name matching, per-document rules,
 * cross-document consistency score and which documents a shop needs.
 */
import { describe, expect, it } from "vitest";

import { parseGstEnrolmentNumber } from "@/lib/kyc/consent";
import { bestNameMatch, nameMatchScore } from "@/lib/kyc/name-match";
import {
  applyDocumentChecks,
  consistencyScore,
  isMandatory,
  requirementFor,
  toStateCode,
  type ShopFacts,
} from "@/server/services/seller-verification-checks";

describe("nameMatchScore", () => {
  it.each([
    ["PATIL RAHUL SURESH", "Rahul Suresh Patil"],
    ["PATIL RAHUL S", "Rahul S. Patil"],
    ["SHREE GANESH DAIRY PRIVATE LIMITED", "M/s Shree Ganesh Dairy Pvt. Ltd."],
    ["ANNAPURNA ENTERPRISES", "Annapurna Enterprise"],
    ["GANESH DAIRY", "Ganesh Dairy Farm"],
  ])("matches %s ~ %s", (a, b) => {
    expect(nameMatchScore(a, b)).toBeGreaterThanOrEqual(85);
  });

  it.each([
    ["KULKARNI BAKERS", "Joshi Sweets"],
    ["DESHMUKH AMIT", "Amol Deshmukh"],
    ["RAHUL", "Rahul Dairy Farm Pvt Ltd"],
    ["RAHUL PATIL", "Rahul Patel"],
  ])("does not auto-match %s ~ %s", (a, b) => {
    expect(nameMatchScore(a, b)).toBeLessThan(85);
  });

  it("scores empty names 0 and picks the best pairing", () => {
    expect(nameMatchScore("", "Rahul")).toBe(0);
    const best = bestNameMatch(["GANESH DAIRY"], ["Rahul Patil", "Ganesh Dairy"]);
    expect(best).toMatchObject({ score: 100, shopName: "Ganesh Dairy" });
  });
});

const shop: ShopFacts = {
  ownerName: "Rahul Patil",
  legalBusinessName: "Ganesh Dairy",
  shopName: "Ganesh Dairy Kothrud",
  pincode: "411038",
  stateCode: "MH",
  isFoodBusiness: true,
};
const base = { shop, nameMatchAutoApprove: 85 };

describe("applyDocumentChecks", () => {
  it("passes a PAN whose name matches the owner", () => {
    const r = applyDocumentChecks({ ...base, docType: "PAN", vendorStatus: "VERIFIED", record: { docStatus: "active", name: "PATIL RAHUL" } });
    expect(r.status).toBe("VERIFIED");
    expect(r.checks.matchedShopName).toBe("Rahul Patil");
  });

  it("sends a PAN name mismatch to review", () => {
    const r = applyDocumentChecks({ ...base, docType: "PAN", vendorStatus: "VERIFIED", record: { docStatus: "active", name: "JOSHI AMOL" } });
    expect(r).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "name_mismatch" });
  });

  it("checks a GSTIN's PAN linkage and state", () => {
    const record = { docStatus: "active" as const, name: "GANESH DAIRY", tradeName: "GANESH DAIRY" };
    expect(
      applyDocumentChecks({ ...base, docType: "GSTIN", vendorStatus: "VERIFIED", record, gstinPanMatchesShopPan: false, gstStateCode: "27" }),
    ).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "gstin_pan_mismatch" });
    expect(
      applyDocumentChecks({ ...base, docType: "GSTIN", vendorStatus: "VERIFIED", record, gstinPanMatchesShopPan: true, gstStateCode: "29" }),
    ).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "state_mismatch" });
    expect(
      applyDocumentChecks({ ...base, docType: "GSTIN", vendorStatus: "VERIFIED", record, gstinPanMatchesShopPan: null, gstStateCode: "27" }),
    ).toMatchObject({ status: "VERIFIED", checks: { panLinked: null, stateMatch: true } });
  });

  it("checks an FSSAI licence's expiry and premises PIN code", () => {
    const ok = { docStatus: "active" as const, name: "Ganesh Dairy", validUntil: "2028-03-31", pincode: "411038" };
    expect(applyDocumentChecks({ ...base, docType: "FSSAI", vendorStatus: "VERIFIED", record: ok }).status).toBe("VERIFIED");
    expect(
      applyDocumentChecks({ ...base, docType: "FSSAI", vendorStatus: "VERIFIED", record: { ...ok, pincode: "411001" } }),
    ).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "address_mismatch" });
    expect(
      applyDocumentChecks({ ...base, docType: "FSSAI", vendorStatus: "VERIFIED", record: { ...ok, validUntil: null } }),
    ).toMatchObject({ status: "MANUAL_REVIEW", errorCode: "expiry_not_returned" });
  });

  it("never upgrades a vendor failure", () => {
    const r = applyDocumentChecks({ ...base, docType: "PAN", vendorStatus: "FAILED", record: null });
    expect(r.status).toBe("FAILED");
  });
});

describe("consistencyScore", () => {
  it("re-weights over the evidence available", () => {
    expect(consistencyScore([]).score).toBeNull();
    expect(
      consistencyScore([{ docType: "PAN", status: "VERIFIED", nameMatchScore: 90, details: {} }]).score,
    ).toBe(90);
  });

  it("drops sharply when the GSTIN's PAN is someone else's", () => {
    const score = consistencyScore([
      { docType: "PAN", status: "VERIFIED", nameMatchScore: 95, details: {} },
      { docType: "GSTIN", status: "VERIFIED", nameMatchScore: 95, details: { panLinked: false, stateMatch: true } },
    ]).score!;
    expect(score).toBeLessThan(80);
  });

  it("ignores documents that were never checked or failed", () => {
    const r = consistencyScore([
      { docType: "PAN", status: "VERIFIED", nameMatchScore: 100, details: {} },
      { docType: "UDYAM", status: "FAILED", nameMatchScore: 10, details: {} },
    ]);
    expect(r.score).toBe(100);
  });
});

describe("requirements", () => {
  it("needs FSSAI only for food shops, GSTIN or a declaration always, Udyam never", () => {
    expect(requirementFor("FSSAI", { isFoodBusiness: true })).toBe("required");
    expect(requirementFor("FSSAI", { isFoodBusiness: false })).toBe("optional");
    expect(requirementFor("GSTIN", { isFoodBusiness: false })).toBe("required_or_declaration");
    expect(isMandatory("UDYAM", { isFoodBusiness: true })).toBe(false);
    expect(isMandatory("SHOP_ACT", { isFoodBusiness: false })).toBe(true);
  });
});

describe("helpers", () => {
  it("normalises state names and codes", () => {
    expect(toStateCode("27")).toBe("MH");
    expect(toStateCode("Maharashtra")).toBe("MH");
    expect(toStateCode("KA")).toBe("KA");
    expect(toStateCode(null)).toBeNull();
  });

  it("shape-checks a GST enrolment number", () => {
    expect(parseGstEnrolmentNumber("27abcde1234f1z5").ok).toBe(true);
    expect(parseGstEnrolmentNumber("123").ok).toBe(false);
  });
});
