import { describe, expect, it } from "vitest";

import { GC } from "@/lib/guest-checkout-i18n";
import { localizeSlotText, ORDER_CARD, ORDER_STATUS_TEXT, orderStatusText } from "@/lib/order-status-i18n";
import { walletDescriptionText, walletTypeText } from "@/lib/wallet-i18n";
import { formatScheduledSlot } from "@/lib/scheduled-slots";

// Staging E2E 25-Nov-2026 (docs/hindi-marathi-2026-11): English left on /track, /orders, /wallet, /cart.

const DEVANAGARI = /[ऀ-ॿ]/;

describe("order status badges", () => {
  it("are translated for every status a customer sees, and English stays as before", () => {
    for (const status of Object.keys(ORDER_STATUS_TEXT)) {
      expect(orderStatusText(status, "hi")).toMatch(DEVANAGARI);
      expect(orderStatusText(status, "mr")).toMatch(DEVANAGARI);
    }
    expect(orderStatusText("PAYMENT_FAILED", "en")).toBe("payment failed");
    expect(orderStatusText("REFUNDED", "en")).toBe("refunded");
    expect(orderStatusText("SOME_NEW_STATUS", "hi")).toBe("some new status");
  });
});

describe("delivery slot line", () => {
  const start = "2026-11-25T09:30:00.000Z"; // 15.00 IST, a Wednesday
  const end = "2026-11-25T10:30:00.000Z";
  it("keeps English unchanged and translates day, month and am/pm", () => {
    const en = formatScheduledSlot(start, end);
    expect(en).toBe("Wed 25 Nov, 3–4 pm");
    expect(localizeSlotText(en, "en")).toBe(en);
    expect(localizeSlotText(en, "hi")).toBe("बुध 25 नव॰, 3–4 शाम");
    expect(localizeSlotText(en, "mr")).not.toMatch(/Wed|Nov|pm/);
  });
  it("leaves other words alone", () => {
    expect(localizeSlotText("Amit · Wed 25 Nov", "hi")).toBe("Amit · बुध 25 नव॰");
  });
});

describe("wallet entries", () => {
  it("types are translated; English as before", () => {
    expect(walletTypeText("PRODUCT_PURCHASE", "en")).toBe("product purchase");
    expect(walletTypeText("TOP_UP", "hi")).toMatch(DEVANAGARI);
    expect(walletTypeText("MANUAL_DEBIT", "mr")).toMatch(DEVANAGARI);
    expect(walletTypeText("NEW_KIND", "hi")).toBe("new kind");
  });
  it("known descriptions keep their order numbers and reasons", () => {
    expect(walletDescriptionText("Refund for cancelled order DB-20261125-A6PDUZ", "en")).toBe("Refund for cancelled order DB-20261125-A6PDUZ");
    expect(walletDescriptionText("Refund for cancelled order DB-20261125-A6PDUZ", "hi")).toBe("रद्द ऑर्डर DB-20261125-A6PDUZ का रिफ़ंड");
    expect(walletDescriptionText("Order GK-1 — E2E Bakery", "mr")).toBe("ऑर्डर GK-1 — E2E Bakery");
    expect(walletDescriptionText("Refund for order GK-2: item missing", "hi")).toBe("ऑर्डर GK-2 का रिफ़ंड: item missing");
    expect(walletDescriptionText("Wallet top-up", "mr")).toBe("वॉलेट टॉप-अप");
  });
  it("unknown descriptions are shown unchanged", () => {
    expect(walletDescriptionText("Adjustment by support", "hi")).toBe("Adjustment by support");
  });
});

describe("track form and order card words", () => {
  it("have Hindi and Marathi for every key", () => {
    const keys = ["trackIntro", "trackReference", "trackByMobile", "trackByEmail", "trackLast4", "trackButton", "trackEmail", "trackCode", "trackFailed", "trackOffline"] as const;
    for (const key of keys) {
      expect(GC[key].hi).toMatch(DEVANAGARI);
      expect(GC[key].mr).toMatch(DEVANAGARI);
    }
    for (const text of Object.values(ORDER_CARD)) {
      expect(text.en.length).toBeGreaterThan(0);
      expect(text.hi).toMatch(DEVANAGARI);
      expect(text.mr).toMatch(DEVANAGARI);
    }
  });
});
