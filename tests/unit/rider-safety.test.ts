import { describe, expect, it } from "vitest";

import { buildSosAlertVars, emergencyContactErrors, insuranceEligibility, isIsoDate, nomineeErrors, sosMapUrl } from "@/lib/rider-safety";

describe("sosMapUrl", () => {
  it("builds a Google Maps link", () => {
    expect(sosMapUrl(18.5204, 73.8567)).toBe("https://www.google.com/maps?q=18.520400,73.856700");
  });
  it("is null without a usable position", () => {
    expect(sosMapUrl(null, 73)).toBeNull();
    expect(sosMapUrl(18, undefined)).toBeNull();
    expect(sosMapUrl(Number.NaN, 73)).toBeNull();
    expect(sosMapUrl(91, 73)).toBeNull();
    expect(sosMapUrl(18, 181)).toBeNull();
  });
});

describe("buildSosAlertVars", () => {
  it("fills every placeholder with an order and a position", () => {
    expect(buildSosAlertVars({ riderName: "Ravi", mobile: "9876543210", orderNumber: "GK-1001", latitude: 18.5, longitude: 73.8 })).toEqual({
      riderName: "Ravi",
      mobile: "9876543210",
      orderPart: " during order GK-1001",
      mapUrl: "https://www.google.com/maps?q=18.500000,73.800000",
    });
  });
  it("reads well without an order or position", () => {
    const vars = buildSosAlertVars({ riderName: " ", mobile: "9876543210" });
    expect(vars.riderName).toBe("A rider");
    expect(vars.orderPart).toBe("");
    expect(vars.mapUrl).toMatch(/not shared/);
  });
});

describe("insuranceEligibility", () => {
  const base = { isActive: true, validFrom: "2026-11-01", validTo: "2027-10-31", minDeliveries: 10, deliveredInWindow: 10, today: "2026-11-25" };
  it("is active with enough deliveries inside the dates", () => {
    expect(insuranceEligibility(base)).toEqual({ active: true, withinDates: true, enoughDeliveries: true, deliveriesShort: 0 });
  });
  it("counts the deliveries still needed", () => {
    const e = insuranceEligibility({ ...base, deliveredInWindow: 7 });
    expect(e.active).toBe(false);
    expect(e.deliveriesShort).toBe(3);
  });
  it("includes both valid dates and excludes days outside", () => {
    expect(insuranceEligibility({ ...base, today: "2026-11-01" }).active).toBe(true);
    expect(insuranceEligibility({ ...base, today: "2027-10-31" }).active).toBe(true);
    expect(insuranceEligibility({ ...base, today: "2026-10-31" }).withinDates).toBe(false);
    expect(insuranceEligibility({ ...base, today: "2027-11-01" }).active).toBe(false);
  });
  it("is inactive when the policy is switched off", () => {
    expect(insuranceEligibility({ ...base, isActive: false }).active).toBe(false);
  });
  it("treats a zero minimum as everyone", () => {
    expect(insuranceEligibility({ ...base, minDeliveries: 0, deliveredInWindow: 0 }).active).toBe(true);
  });
});

describe("nomineeErrors", () => {
  it("accepts a complete nominee", () => {
    expect(nomineeErrors({ name: "Sita Devi", relation: "Mother", mobile: "9123456780", dateOfBirth: "1970-01-15" }, "2026-11-25")).toEqual({});
  });
  it("flags bad fields", () => {
    const errors = nomineeErrors({ name: "S", relation: "", mobile: "12345", dateOfBirth: "2030-01-01" }, "2026-11-25");
    expect(Object.keys(errors).sort()).toEqual(["dateOfBirth", "mobile", "name", "relation"]);
  });
  it("mobile and date of birth are optional", () => {
    expect(nomineeErrors({ name: "Sita", relation: "Wife", mobile: null, dateOfBirth: "" }, "2026-11-25")).toEqual({});
  });
});

describe("emergencyContactErrors", () => {
  it("needs a different valid mobile", () => {
    expect(emergencyContactErrors({ name: "Asha", mobile: "9876543210", relation: "Wife" }, "9876543210").mobile).toMatch(/different/);
    expect(emergencyContactErrors({ name: "Asha", mobile: "123", relation: "" }, "9876543210").mobile).toBeDefined();
    expect(emergencyContactErrors({ name: "Asha", mobile: "9123456780" }, "9876543210")).toEqual({});
  });
});

describe("isIsoDate", () => {
  it("checks shape and calendar", () => {
    expect(isIsoDate("2026-11-25")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("25-11-2026")).toBe(false);
  });
});
