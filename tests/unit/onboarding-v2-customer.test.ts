/**
 * docs/onboarding-v2-2026-11, Flow 1 (customer signs in only at checkout): the pure parts — the guest's signed
 * Terms tick, where the login sheet resumes, and which orders still take a delivery location.
 */
import { describe, expect, it } from "vitest";

import { isSheetResumePath, sheetResumePath } from "@/lib/onboarding-v2-sheet";
import {
  ADDRESS_OPEN_STATUSES,
  awaitingDeliveryAddress,
  createTermsToken,
  readTermsToken,
  V2_TERMS_MAX_AGE_S,
} from "@/server/onboarding-v2/customer";

const NOW = 1_800_000_000_000;

describe("Terms tick token (login sheet step 1)", () => {
  it("round-trips the version and the time it was ticked", () => {
    const token = createTermsToken({ version: "2026-10-24", acceptedAt: new Date(NOW) });
    expect(readTermsToken(token, NOW + 60_000)).toEqual({ version: "2026-10-24", acceptedAt: new Date(NOW) });
  });

  it("is refused when tampered with, malformed or missing", () => {
    const token = createTermsToken({ version: "2026-10-24", acceptedAt: new Date(NOW) });
    const [version, at, mac] = token.split(".");
    expect(readTermsToken(`${version}.${Number(at) - 1000}.${mac}`, NOW)).toBeNull();
    expect(readTermsToken(`2026-11-01.${at}.${mac}`, NOW)).toBeNull();
    expect(readTermsToken(`${version}.${at}.${mac.slice(1)}x`, NOW)).toBeNull();
    expect(readTermsToken("nonsense", NOW)).toBeNull();
    expect(readTermsToken(undefined, NOW)).toBeNull();
  });

  it("lasts V2_TERMS_MAX_AGE_S and is never from the future", () => {
    const token = createTermsToken({ version: "2026-10-24", acceptedAt: new Date(NOW) });
    expect(readTermsToken(token, NOW + V2_TERMS_MAX_AGE_S * 1000)).not.toBeNull();
    expect(readTermsToken(token, NOW + V2_TERMS_MAX_AGE_S * 1000 + 1)).toBeNull();
    expect(readTermsToken(token, NOW - 5 * 60_000)).toBeNull();
  });
});

describe("login sheet resume path (step 2 → step 3)", () => {
  it("adds ?sheet=resume to the page the sheet was opened from", () => {
    expect(sheetResumePath("/cart")).toBe("/cart?sheet=resume");
    expect(sheetResumePath("/orders?tab=past")).toBe("/orders?tab=past&sheet=resume");
  });

  it("falls back to the cart for unsafe or missing paths", () => {
    expect(sheetResumePath("https://evil.example/x")).toBe("/cart?sheet=resume");
    expect(sheetResumePath("//evil.example")).toBe("/cart?sheet=resume");
    expect(sheetResumePath("/signin")).toBe("/cart?sheet=resume");
    expect(sheetResumePath(null)).toBe("/cart?sheet=resume");
  });

  it("recognises a resume path (the /onboarding page sends it straight back)", () => {
    expect(isSheetResumePath("/cart?sheet=resume")).toBe(true);
    expect(isSheetResumePath("/cart")).toBe(false);
    expect(isSheetResumePath("/cart?sheet=other")).toBe(false);
    expect(isSheetResumePath("https://x/cart?sheet=resume")).toBe(false);
  });
});

describe("delivery location after payment (step 5)", () => {
  it("waits only while address_pending_since is set", () => {
    expect(awaitingDeliveryAddress({ addressPendingSince: new Date() })).toBe(true);
    expect(awaitingDeliveryAddress({ addressPendingSince: null })).toBe(false);
  });

  it("is open until the order is out, delivered, cancelled or refunded", () => {
    expect(ADDRESS_OPEN_STATUSES).toEqual(expect.arrayContaining(["PENDING", "CONFIRMED", "ACCEPTED", "PREPARING", "READY"]));
    for (const closed of ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "REFUNDED", "PAYMENT_FAILED", "ASSIGNED", "PICKED_UP"]) {
      expect(ADDRESS_OPEN_STATUSES).not.toContain(closed);
    }
  });
});
