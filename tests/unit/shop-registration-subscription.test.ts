/** Registration subscription (0206) — pure parts: reminder schedule, expiry changes, status, fees, text. */
import { describe, expect, it } from "vitest";

import type { IsoDate } from "@/lib/dates";
import { offlineFromOf, registrationStatusOf, renewalQuoteFrom } from "@/server/services/shop-membership";
import { daysLeft, newExpiryFor, reminderPlanFor, reminderText } from "@/server/services/shop-registration-subscription";

const RULE = { unpaidReminderDays: [1, 3, 7], unpaidRepeatEveryDays: 7, expiryReminderDays: [30, 15, 7, 6, 5, 4, 3, 2, 1, 0], graceDaily: true };
const d = (s: string) => s as IsoDate;

describe("reminderPlanFor", () => {
  const unpaid = (registeredOn: string) => ({ status: "UNPAID" as const, registeredOn: d(registeredOn), expiresOn: null, offlineOn: null });
  it("unpaid: days 1, 3, 7 then weekly", () => {
    const sent = Array.from({ length: 30 }, (_, i) => i).filter((n) => reminderPlanFor(unpaid("2026-11-01"), d(`2026-11-${String(1 + n).padStart(2, "0")}`), RULE));
    expect(sent).toEqual([1, 3, 7, 14, 21, 28]);
    expect(reminderPlanFor(unpaid("2026-11-01"), d("2026-11-04"), RULE)).toEqual({ kind: "UNPAID", stage: "U3" });
  });
  it("no weekly repeat when 0", () => {
    expect(reminderPlanFor(unpaid("2026-11-01"), d("2026-11-15"), { ...RULE, unpaidRepeatEveryDays: 0 })).toBeNull();
  });
  it("expiry: 30, 15, each of the last 7 days and the day itself", () => {
    const live = (expiresOn: string) => ({ status: "EXPIRING_SOON" as const, registeredOn: d("2025-12-01"), expiresOn: d(expiresOn), offlineOn: d("2026-12-08") });
    const days = [];
    for (let i = 0; i <= 40; i++) {
      const day = new Date(Date.UTC(2026, 9, 31 + i)).toISOString().slice(0, 10);
      const plan = reminderPlanFor(live("2026-12-01"), d(day), RULE);
      if (plan) days.push(plan.stage);
    }
    expect(days).toEqual(["E30", "E15", "E7", "E6", "E5", "E4", "E3", "E2", "E1", "E0", "G1", "G2", "G3", "G4", "G5", "G6", "X0"]);
  });
  it("grace daily off: only the grace-end notice", () => {
    const row = { status: "GRACE" as const, registeredOn: d("2025-12-01"), expiresOn: d("2026-12-01"), offlineOn: d("2026-12-08") };
    expect(reminderPlanFor(row, d("2026-12-03"), { ...RULE, graceDaily: false })).toBeNull();
    expect(reminderPlanFor(row, d("2026-12-08"), { ...RULE, graceDaily: false })).toEqual({ kind: "RENEWAL", stage: "X0" });
  });
  it("exempt shops are never reminded", () => {
    expect(reminderPlanFor({ status: "EXEMPT", registeredOn: d("2026-11-01"), expiresOn: d("2026-11-02"), offlineOn: null }, d("2026-11-02"), RULE)).toBeNull();
  });
});

describe("newExpiryFor", () => {
  const now = new Date("2026-11-25T04:00:00Z");
  const cur = new Date("2026-12-31T18:29:59Z");
  it("extend from the current expiry (or now when it passed)", () => {
    expect(newExpiryFor(cur, { mode: "EXTEND", days: 10 }, now).getTime()).toBe(cur.getTime() + 10 * 86_400_000);
    const past = new Date("2026-01-01T00:00:00Z");
    expect(newExpiryFor(past, { mode: "EXTEND", days: 10 }, now).getTime()).toBe(now.getTime() + 10 * 86_400_000);
  });
  it("shorten needs an expiry", () => {
    expect(() => newExpiryFor(null, { mode: "SHORTEN", days: 1 }, now)).toThrow();
    expect(newExpiryFor(cur, { mode: "SHORTEN", days: 1 }, now).getTime()).toBe(cur.getTime() - 86_400_000);
  });
  it("set date: the end of that IST day", () => {
    expect(newExpiryFor(null, { mode: "SET_DATE", date: "2027-03-31" }, now).toISOString()).toBe("2027-03-31T18:29:59.000Z");
  });
  it("expire now: never later than now", () => {
    expect(newExpiryFor(cur, { mode: "EXPIRE_NOW" }, now).getTime()).toBeLessThanOrEqual(now.getTime());
  });
});

describe("status and grace", () => {
  const unpaidShop = { registrationFeePaise: 100_000, amountPaidPaise: 0, feePaymentStatus: "PENDING" as const };
  const paidShop = { registrationFeePaise: 100_000, amountPaidPaise: 100_000, feePaymentStatus: "PAID" as const };
  it("maps membership states", () => {
    expect(registrationStatusOf(unpaidShop, { state: "NONE" })).toBe("UNPAID");
    expect(registrationStatusOf(paidShop, { state: "NONE" })).toBe("ACTIVE");
    expect(registrationStatusOf(paidShop, { state: "DUE_SOON" })).toBe("EXPIRING_SOON");
    expect(registrationStatusOf(paidShop, { state: "GRACE" })).toBe("GRACE");
    expect(registrationStatusOf(paidShop, { state: "LAPSED" })).toBe("EXPIRED");
    expect(registrationStatusOf(unpaidShop, { state: "EXEMPT" })).toBe("EXEMPT");
  });
  it("grace: the shop's own days, else the rule's; a later grace-until wins", () => {
    const until = new Date("2026-12-01T00:00:00Z");
    expect(offlineFromOf(until, {}, 7).toISOString()).toBe("2026-12-08T00:00:00.000Z");
    expect(offlineFromOf(until, { registrationGraceDays: 0 }, 7).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(offlineFromOf(until, { registrationGraceUntil: new Date("2026-12-20T00:00:00Z") }, 7).toISOString()).toBe("2026-12-20T00:00:00.000Z");
  });
  it("days left in IST calendar days", () => {
    expect(daysLeft(new Date("2026-11-30T10:00:00Z"), new Date("2026-11-25T04:00:00Z"))).toBe(5);
    expect(daysLeft(null)).toBeNull();
  });
});

describe("renewal fee precedence", () => {
  const shop = { registrationFeeBasePaise: 84_746, registrationFeePaise: 100_000, shopType: "WHOLESALE" };
  const rule = { renewalFeePaise: 0, addGst: true };
  it("shop's own fee > shop type > rule > the shop's registration base", () => {
    expect(renewalQuoteFrom(shop, rule, 1800).basePaise).toBe(84_746);
    expect(renewalQuoteFrom(shop, { ...rule, renewalFeePaise: 90_000 }, 1800).source).toBe("RULE");
    expect(renewalQuoteFrom(shop, rule, 1800, { WHOLESALE: 211_864 })).toMatchObject({ basePaise: 211_864, source: "SHOP_TYPE", totalPaise: 211_864 + Math.round(211_864 * 0.18) });
    expect(renewalQuoteFrom({ ...shop, renewalFeePaise: 50_000 }, rule, 1800, { WHOLESALE: 211_864 })).toMatchObject({ basePaise: 50_000, source: "SHOP_OVERRIDE" });
  });
});

describe("reminderText", () => {
  it("unpaid: English + Marathi, no orders until paid, the link", () => {
    const t = reminderText({ kind: "UNPAID", shopName: "Ram Dairy", status: "UNPAID", expiresOn: null, amount: "₹1,000.00", link: "https://x/pay", daysLeft: null });
    expect(t.title).toContain("Complete your registration payment");
    expect(t.message).toContain("will not receive orders");
    expect(t.message).toContain("आत्ताच भरा: https://x/pay");
  });
  it("renewal: days left, expired wording", () => {
    expect(reminderText({ kind: "RENEWAL", shopName: "A", status: "EXPIRING_SOON", expiresOn: "1 Dec 2026", amount: "₹1,000.00", link: "L", daysLeft: 15 }).title).toContain("in 15 days");
    expect(reminderText({ kind: "RENEWAL", shopName: "A", status: "EXPIRED", expiresOn: "1 Dec 2026", amount: "₹1,000.00", link: "L", daysLeft: -9 }).message).toContain("hidden from customers");
  });
});
