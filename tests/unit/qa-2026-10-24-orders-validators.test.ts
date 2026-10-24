/**
 * Pure rules behind the orders / riders fixes of the QA run of 24 Oct 2026:
 * rider KYC, bank and vehicle numbers (TC-FLD-091/092/093, TC-DEL-030), the
 * customer's own cancel (TC-ORD-008), whole-piece returns (TC-RET-003 /
 * TC-FLD-094), the remove-line reasons (TC-FLD-083) and rupee amounts typed
 * into staff money forms (TC-FLD-099).
 */
import { describe, expect, it } from "vitest";

import {
  checkRiderAccountNumber,
  checkRiderDetails,
  checkRiderGovernmentId,
  checkRiderIfsc,
  checkRiderPan,
  isAadhaarIdType,
  normaliseVehicleRegistration,
} from "@/lib/kyc/rider-details";
import {
  SELF_CANCEL_AFTER_PACKING,
  customerCancellableStatuses,
  selfCancelBlock,
  type SelfCancelRules,
} from "@/lib/order-cancellation";
import { DEFAULT_REMOVE_LINE_REASON, REMOVE_LINE_REASONS, SHOP_REMOVE_LINE_REASON } from "@/lib/order-line-removal";
import { returnQuantityStepError, returnsInWholePieces } from "@/lib/return-states";
import { RUPEE_DECIMALS_MESSAGE, parseRupeeInput } from "@/lib/rupee-input";
import { paymentMethodLabel } from "@/lib/payment-methods";
import { renderEmail } from "@/server/notifications/templates";
import { ORDER_TRANSITIONS } from "@/lib/state-machines";
import type { OrderStatus } from "@/server/db/schema";

describe("rider KYC and bank numbers (TC-FLD-092 / TC-FLD-093 / TC-DEL-030)", () => {
  it("PAN: AAAAA9999A, upper-cased", () => {
    expect(checkRiderPan("abcde1234f")).toEqual({ ok: true, value: "ABCDE1234F" });
    for (const bad of ["ABC12", "ABCDE12345", "1BCDE1234F"]) expect(checkRiderPan(bad).ok, bad).toBe(false);
  });

  it("Aadhaar: 12 digits, spaces allowed, first digit 2–9, valid check digit — only when the ID type says Aadhaar", () => {
    expect(checkRiderGovernmentId("Aadhaar", "4321 4321 4321")).toEqual({ ok: true, value: "432143214321" });
    for (const bad of ["12", "1234 5678 9012", "023412341234", "432143214322", "4321-4321-432A"]) {
      expect(checkRiderGovernmentId("Aadhaar", bad).ok, bad).toBe(false);
    }
    for (const type of ["Aadhaar", "aadhar card", "Adhaar", "UID"]) expect(isAadhaarIdType(type), type).toBe(true);
    expect(isAadhaarIdType("Voter ID")).toBe(false);
    expect(checkRiderGovernmentId("Voter ID", " ABC1234567 ")).toEqual({ ok: true, value: "ABC1234567" });
  });

  it("bank account: 9 to 18 digits only", () => {
    expect(checkRiderAccountNumber("1234 5678 9012")).toEqual({ ok: true, value: "123456789012" });
    for (const bad of ["12345678", "1234567890123456789", "12AB34CD5678", "12AB34CD56"]) {
      expect(checkRiderAccountNumber(bad).ok, bad).toBe(false);
    }
  });

  it("IFSC: 4 letters, 0, 6 letters or digits; lower case converted", () => {
    expect(checkRiderIfsc("sbin0001234")).toEqual({ ok: true, value: "SBIN0001234" });
    for (const bad of ["SBIN000123", "SBIN1001234", "SBIN12"]) {
      expect(checkRiderIfsc(bad), bad).toEqual({ ok: false, error: "IFSC must be 11 characters, e.g. SBIN0001234." });
    }
  });

  it("checkRiderDetails names each bad field and leaves blanks as 'not given'", () => {
    expect(checkRiderDetails({ panNumber: "ABC12", bankIfsc: "SBIN1001234", bankAccountNumber: "  " })).toMatchObject({
      ok: false,
      fields: { panNumber: expect.any(String), bankIfsc: expect.any(String) },
    });
    expect(checkRiderDetails({ panNumber: null, bankAccountNumber: "", vehicleRegistrationNumber: "mh12ab1234" })).toEqual({
      ok: true,
      values: { panNumber: null, bankAccountNumber: null, vehicleRegistrationNumber: "MH12AB1234" },
    });
  });
});

describe("vehicle registration numbers (TC-FLD-091 / TC-DEL-030)", () => {
  it("normalises case and spaces the same way everywhere", () => {
    expect(normaliseVehicleRegistration("  mh12 ab   1234 ")).toEqual({ ok: true, value: "MH12 AB 1234" });
    for (const good of ["MH12AB1234", "MH-12-AB-1234", "DL 3C AB 1234", "MH12 1234", "22 BH 1234 AA", "22BH1234A"]) {
      expect(normaliseVehicleRegistration(good).ok, good).toBe(true);
    }
  });

  it("refuses symbols and shapes that are not a registration mark", () => {
    for (const bad of ["MH-12/AB@1234#", "MH12@#$%^&*", "HELLO", "1234", "MH12ABCD12345"]) {
      expect(normaliseVehicleRegistration(bad).ok, bad).toBe(false);
    }
  });
});

describe("the customer's own cancel (TC-ORD-008)", () => {
  const off: SelfCancelRules = { customerMayCancelUntil: "CONFIRMED", afterPackingEnabled: false };
  const on: SelfCancelRules = { customerMayCancelUntil: "PREPARING", afterPackingEnabled: true };

  it("My Orders offers Cancel after pickup (goods-only refund) under the default rules", () => {
    expect(customerCancellableStatuses(off)).toEqual(["CONFIRMED", "PICKED_UP", "OUT_FOR_DELIVERY"]);
    expect(customerCancellableStatuses(on).sort()).toEqual(
      ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"].sort(),
    );
  });

  it("the screen's list never disagrees with the server's rule", () => {
    for (const rules of [off, on, { ...off, afterPackingEnabled: true }, { ...on, afterPackingEnabled: false }]) {
      const offered = customerCancellableStatuses(rules);
      for (const status of Object.keys(ORDER_TRANSITIONS) as OrderStatus[]) {
        if (offered.includes(status)) expect(selfCancelBlock(status, rules), status).toBeNull();
      }
    }
    expect(selfCancelBlock("FAILED", on)).toBe("CONTACT_SUPPORT");
    expect(selfCancelBlock("DELIVERED", on)).toBe("NOT_CANCELLABLE");
    expect(SELF_CANCEL_AFTER_PACKING).toEqual(["READY", "ASSIGNED"]);
  });
});

describe("whole-piece returns (TC-RET-003 / TC-FLD-094)", () => {
  it("per-piece units need whole pieces; weight and volume keep any quantity", () => {
    for (const unit of ["piece", "pack", "unit", "pcs", "dozen"]) expect(returnsInWholePieces(unit), unit).toBe(true);
    for (const unit of ["kg", "g", "L", "ml", "litre"]) expect(returnsInWholePieces(unit), unit).toBe(false);
    expect(returnQuantityStepError("piece", 1500, "White Bread")).toMatch(/whole number of pieces/);
    expect(returnQuantityStepError("piece", 2000, "White Bread")).toBeNull();
    expect(returnQuantityStepError("L", 1500, "Cow Milk")).toBeNull();
  });
});

describe("remove-line reasons (TC-FLD-083)", () => {
  it("the shop screen's reason and the no-reason default are on the list", () => {
    expect(REMOVE_LINE_REASONS).toContain(SHOP_REMOVE_LINE_REASON);
    expect(REMOVE_LINE_REASONS).toContain(DEFAULT_REMOVE_LINE_REASON);
  });
});

describe("rupee amounts in staff money forms (TC-FLD-099)", () => {
  it("reads up to two decimals exactly and refuses more instead of rounding", () => {
    expect(parseRupeeInput("10.55")).toEqual({ ok: true, paise: 1055 });
    expect(parseRupeeInput("70")).toEqual({ ok: true, paise: 7000 });
    expect(parseRupeeInput("70.5")).toEqual({ ok: true, paise: 7050 });
    expect(parseRupeeInput("0.1")).toEqual({ ok: true, paise: 10 });
    expect(parseRupeeInput("10.555")).toEqual({ ok: false, error: RUPEE_DECIMALS_MESSAGE });
    expect(parseRupeeInput("-5")).toMatchObject({ ok: false });
    expect(parseRupeeInput("-5.25", { allowNegative: true })).toEqual({ ok: true, paise: -525 });
    expect(parseRupeeInput("abc")).toMatchObject({ ok: false });
    expect(parseRupeeInput("  ")).toEqual({ ok: "empty" });
  });
});

describe("payment method on the order screens (TC-SPI-006 / TC-SPI-008)", () => {
  it("names every method", () => {
    expect(paymentMethodLabel("WALLET")).toBe("Wallet");
    expect(paymentMethodLabel("COD")).toBe("Cash on delivery");
    expect(paymentMethodLabel("ONLINE")).toMatch(/^Online/);
    expect(paymentMethodLabel(null)).toBeNull();
  });
});

describe("e-mail detail rows (TC-SPI-004)", () => {
  it("are listed under the body in text and html, escaped; without rows the e-mail is unchanged", () => {
    const plain = renderEmail({ title: "Order confirmed", body: "Your order GK-1 is confirmed." });
    const withRows = renderEmail({
      title: "Order confirmed",
      body: "Your order GK-1 is confirmed.",
      detail: [
        { label: "<b>Jam</b> × 2 piece", value: "₹251.00" },
        { label: "Total", value: "₹271.00" },
      ],
    });
    expect(withRows.text).toContain("Your order GK-1 is confirmed.\n\n<b>Jam</b> × 2 piece: ₹251.00\nTotal: ₹271.00\n");
    expect(withRows.html).toContain("&lt;b&gt;Jam&lt;/b&gt; × 2 piece");
    expect(withRows.html).not.toContain("<b>Jam</b>");
    expect(plain.text).toBe("Order confirmed\n\nYour order GK-1 is confirmed.\n\nYou receive this because of your notification settings on Gokesari.");
  });
});
