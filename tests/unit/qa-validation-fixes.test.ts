/**
 * Field checks fixed after the QA run of 24 Oct 2026 (tests/qa): each case
 * names the TC ID whose run found the gap.
 */
import { describe, expect, it } from "vitest";

import { isIndianPhone, mobileFieldDigits, parseIndianMobile } from "@/lib/contact";
import { segmentRulesProblem } from "@/lib/segment-form";

describe("TC-FLD-105: a society's gate contact is a phone someone can call", () => {
  it.each(["+91 98765 43210", "9876543210", "020 2612 3456", "02026123456", "+91 20 2612 3456"])("accepts %s", (value) => {
    expect(isIndianPhone(value)).toBe(true);
  });
  it.each(["123456", "12", "abc", "a@b.com", "98765@4321", "0000000000", "98765432101"])("refuses %s", (value) => {
    expect(isIndianPhone(value)).toBe(false);
  });
});

describe("TC-FLD-106: a society rider's mobile is read as typed, not as its last 10 digits", () => {
  it("refuses 11 digits and letters inside the number", () => {
    expect(parseIndianMobile("19876543210").ok).toBe(false);
    expect(parseIndianMobile("67456ab20809").ok).toBe(false);
  });
  it("accepts +91 and a 12-digit 91… number", () => {
    expect(parseIndianMobile("+91 98765 43210")).toMatchObject({ ok: true, national: "9876543210" });
    expect(parseIndianMobile("919876543210")).toMatchObject({ ok: true, national: "9876543210" });
  });
});

describe("TC-LOC-009 / TC-FLD-012: a pasted +91 number keeps the national digits", () => {
  it.each([
    ["+91 98765 43210", "9876543210"],
    ["919876543210", "9876543210"],
    ["98765 43210", "9876543210"],
    ["98765432109999", "9876543210"],
  ])("%s → %s", (typed, kept) => {
    expect(mobileFieldDigits(typed)).toBe(kept);
  });
});

describe("TC-FLD-122: text in a segment's number field is refused, not dropped", () => {
  const blank = { pincodes: "", minOrders: "", orderedWithinDays: "", lapsedForDays: "", minSpendRupees: "" };
  it("a blank form (all customers) and whole numbers are fine", () => {
    expect(segmentRulesProblem(blank)).toBeNull();
    expect(segmentRulesProblem({ ...blank, minOrders: "3", orderedWithinDays: "30", minSpendRupees: "499.50" })).toBeNull();
  });
  it.each([
    ["minOrders", "abc"],
    ["minOrders", "0"],
    ["minOrders", "-1"],
    ["orderedWithinDays", "1.5"],
    ["lapsedForDays", "ten"],
    ["minSpendRupees", "10.555"],
    ["minSpendRupees", "five hundred"],
  ] as const)("%s = %s", (field, value) => {
    expect(segmentRulesProblem({ ...blank, [field]: value })).toMatch(/enter/);
  });
});
