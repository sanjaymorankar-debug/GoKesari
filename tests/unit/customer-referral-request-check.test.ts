/**
 * A customer's request for a referral code (docs/four-features-2026-10, the
 * owner's decision of 9 Oct 2026): the shop owner's checks without shop type
 * and area.
 */
import { describe, expect, it } from "vitest";

import { checkCustomerReferralRequest, customerReferralRequestReference } from "@/lib/referral-requests";

describe("checkCustomerReferralRequest", () => {
  it("cleans a good request and builds the Google Maps link", () => {
    const checked = checkCustomerReferralRequest({ name: "  Anil   Patil ", mobile: "98765 43210", city: " Pune ", pincode: "411001", latitude: 18.52043031, longitude: 73.8567437, accuracyM: 9.6 });
    expect(checked).toEqual({
      ok: true,
      value: {
        name: "Anil Patil",
        mobileE164: "+919876543210",
        city: "Pune",
        pincode: "411001",
        location: { latitude: 18.52043, longitude: 73.856744, accuracyM: 10, mapsUrl: "https://www.google.com/maps?q=18.52043,73.856744" },
      },
    });
  });

  it("asks only for name, contact number, city and PIN code — never shop type or area", () => {
    const checked = checkCustomerReferralRequest({ name: "", mobile: "123", city: "", pincode: "011001" });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(Object.keys(checked.fields).sort()).toEqual(["city", "mobile", "name", "pincode"]);
  });

  it("goes without a location, and refuses impossible coordinates", () => {
    const base = { name: "Anil", mobile: "9876543210", city: "Pune", pincode: "411001" };
    const without = checkCustomerReferralRequest(base);
    expect(without.ok && without.value.location).toBeNull();
    const bad = checkCustomerReferralRequest({ ...base, latitude: 123, longitude: 73 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.fields)).toEqual(["location"]);
  });

  it("references customer requests apart from shop owners' RCR- ones", () => {
    expect(customerReferralRequestReference("1a2b3c4d-0000-4000-8000-000000000000")).toBe("CRR-1A2B3C4D");
  });
});
