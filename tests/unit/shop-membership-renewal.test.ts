/**
 * Shop membership renewal (modules 8 + 9, docs/shop-membership-renewal-2026-11): the pure rules —
 * status with exemptions and the OFF switch, the renewal fee, which payments open or take back a
 * period, the reminder stages, when Renew now may be pressed, and the CSV.
 */
import { describe, expect, it } from "vitest";

import {
  isMembershipExempt,
  membershipEndAfterPayment,
  membershipEndAfterRollback,
  membershipStatus,
  periodsToRollBack,
  poolCoversNextPeriod,
  renewalQuoteFrom,
} from "@/server/services/shop-membership";
import { membershipReportCsv, reminderStageFor, renewalPeriodKey, renewalRefusal, type MembershipReportRow } from "@/server/services/shop-membership-renewal";

const DAY = 86_400_000;
const NOW = new Date("2027-03-10T06:30:00Z"); // 12.00 IST
const RULE = { enabled: true, graceDays: 15, reminderDays: 30, exemptShopTypes: [] as string[], exemptCategorySlugs: [] as string[] };
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

describe("membership status", () => {
  it("ACTIVE, DUE_SOON, GRACE and LAPSED while enforced", () => {
    expect(membershipStatus({ membershipValidUntil: inDays(60) }, RULE, NOW)).toMatchObject({ state: "ACTIVE", enforced: true });
    expect(membershipStatus({ membershipValidUntil: inDays(20) }, RULE, NOW).state).toBe("DUE_SOON");
    expect(membershipStatus({ membershipValidUntil: inDays(-5) }, RULE, NOW).state).toBe("GRACE");
    expect(membershipStatus({ membershipValidUntil: inDays(-20) }, RULE, NOW).state).toBe("LAPSED");
    expect(membershipStatus({ membershipValidUntil: null }, RULE, NOW)).toMatchObject({ state: "NONE", validUntil: null });
  });

  it("OFF: an ended membership never lapses and is not enforced", () => {
    const off = { ...RULE, enabled: false };
    expect(membershipStatus({ membershipValidUntil: inDays(-400) }, off, NOW)).toMatchObject({ state: "GRACE", enforced: false });
  });

  it("exempt by the per-shop switch, the shop type or a category: EXEMPT, not enforced, no offline date", () => {
    const lapsed = { membershipValidUntil: inDays(-60) };
    expect(membershipStatus({ ...lapsed, membershipExempt: true }, RULE, NOW)).toMatchObject({ state: "EXEMPT", enforced: false, offlineFrom: null });
    const byType = { ...RULE, exemptShopTypes: ["PHARMACY"] };
    expect(membershipStatus({ ...lapsed, shopType: "PHARMACY" }, byType, NOW).state).toBe("EXEMPT");
    expect(membershipStatus({ ...lapsed, shopType: "DAIRY" }, byType, NOW).state).toBe("LAPSED");
    const byCategory = { ...RULE, exemptCategorySlugs: ["temple-trust"] };
    expect(membershipStatus(lapsed, byCategory, NOW, ["grocery", "temple-trust"]).state).toBe("EXEMPT");
    expect(membershipStatus(lapsed, byCategory, NOW, ["grocery"]).state).toBe("LAPSED");
    expect(isMembershipExempt({ membershipExempt: false, shopType: "DAIRY" }, {}, [])).toBe(false);
  });
});

describe("extension from the current expiry", () => {
  it("adds the period to the end while it lasts, else from the payment", () => {
    const end = new Date("2027-04-01T00:00:00Z");
    expect(membershipEndAfterPayment(end, NOW, 12).toISOString()).toBe("2028-04-01T00:00:00.000Z");
    expect(membershipEndAfterPayment(inDays(-30), NOW, 12).toISOString()).toBe("2028-03-10T06:30:00.000Z");
  });
});

describe("renewal fee", () => {
  const shop = { registrationFeeBasePaise: 99_900, registrationFeePaise: 1_17_882 };
  it("the shop's registration base fee plus GST at today's rate (no coupon carried over)", () => {
    expect(renewalQuoteFrom(shop, { renewalFeePaise: 0, addGst: true }, 1800)).toEqual({ basePaise: 99_900, gstRateBp: 1800, gstPaise: 17_982, totalPaise: 1_17_882, source: "SHOP_BASE" });
  });
  it("a fixed admin fee, with or without GST", () => {
    expect(renewalQuoteFrom(shop, { renewalFeePaise: 50_000, addGst: true }, 1800)).toMatchObject({ basePaise: 50_000, gstPaise: 9_000, totalPaise: 59_000, source: "RULE" });
    expect(renewalQuoteFrom(shop, { renewalFeePaise: 50_000, addGst: false }, 1800)).toMatchObject({ gstPaise: 0, totalPaise: 50_000, gstRateBp: 0 });
  });
  it("a shop registered before the breakdown was kept renews at its registration total", () => {
    expect(renewalQuoteFrom({ registrationFeeBasePaise: null, registrationFeePaise: 500_000 }, { renewalFeePaise: 0, addGst: true }, 1800)).toEqual({
      basePaise: 500_000,
      gstRateBp: 0,
      gstPaise: 0,
      totalPaise: 500_000,
      source: "SHOP_TOTAL",
    });
  });
});

describe("periods: partial instalments, duplicates and rollback", () => {
  it("a part payment does not cover the period; the instalment that completes it does", () => {
    expect(poolCoversNextPeriod(40_000, 99_900)).toBe(false);
    expect(poolCoversNextPeriod(99_900, 99_900)).toBe(true);
    expect(poolCoversNextPeriod(120_000, 99_900)).toBe(true);
    expect(poolCoversNextPeriod(10, 0)).toBe(true);
  });

  it("a refund takes back the newest periods until the fees pay for the rest; LEGACY is never taken back", () => {
    const periods = [
      { id: "r2", kind: "RENEWAL", feePaise: 100 },
      { id: "r1", kind: "RENEWAL", feePaise: 100 },
      { id: "l", kind: "LEGACY", feePaise: 500 },
    ];
    expect(periodsToRollBack(periods, 0)).toEqual([]);
    expect(periodsToRollBack(periods, -1).map((p) => p.id)).toEqual(["r2"]);
    expect(periodsToRollBack(periods, -150).map((p) => p.id)).toEqual(["r2", "r1"]);
    expect(periodsToRollBack(periods, -10_000).map((p) => p.id)).toEqual(["r2", "r1"]);
  });

  it("rolls the end back to before the period (latest), or by its length (an older one)", () => {
    const period = { periodStart: new Date("2027-04-01T00:00:00Z"), periodEnd: new Date("2028-04-01T00:00:00Z"), previousValidUntil: new Date("2027-04-01T00:00:00Z") };
    expect(membershipEndAfterRollback(period.periodEnd, period)?.toISOString()).toBe("2027-04-01T00:00:00.000Z");
    // A referral month was added after it: the year comes off, the month stays.
    const later = new Date("2028-05-01T00:00:00Z");
    expect(membershipEndAfterRollback(later, period)?.toISOString()).toBe("2027-05-01T00:00:00.000Z");
    // The first period of a lapsed shop: back to the date it started (ended), never to "no end date".
    expect(membershipEndAfterRollback(period.periodEnd, { ...period, previousValidUntil: null })?.toISOString()).toBe("2027-04-01T00:00:00.000Z");
    expect(membershipEndAfterRollback(null, period)).toBeNull();
  });

  it("the idempotency period key is the current end date", () => {
    expect(renewalPeriodKey(new Date("2027-04-01T18:30:00Z"))).toBe("2027-04-01");
    expect(renewalPeriodKey(null)).toBe("none");
  });
});

describe("Renew now", () => {
  const rule = { renewalCheckoutEnabled: true, renewalWindowDays: 30 };
  const base = { shopStatus: "APPROVED", registrationFeeDuePaise: 0, totalPaise: 1_17_882 };
  const st = (days: number | null, extra: Partial<ReturnType<typeof membershipStatus>> = {}) => ({
    ...membershipStatus({ membershipValidUntil: days === null ? null : inDays(days) }, RULE, NOW),
    ...extra,
  });

  it("OFF blocks new checkouts only", () => {
    expect(renewalRefusal({ ...base, status: st(10) }, { ...rule, renewalCheckoutEnabled: false }, NOW)).toBe("CHECKOUT_OFF");
  });
  it("opens inside the window and after the end; not earlier, not without an end date", () => {
    expect(renewalRefusal({ ...base, status: st(10) }, rule, NOW)).toBeNull();
    expect(renewalRefusal({ ...base, status: st(-20) }, rule, NOW)).toBeNull();
    expect(renewalRefusal({ ...base, status: st(90) }, rule, NOW)).toBe("TOO_EARLY");
    expect(renewalRefusal({ ...base, status: st(45) }, { ...rule, renewalWindowDays: 60 }, NOW)).toBeNull();
    expect(renewalRefusal({ ...base, status: st(null) }, rule, NOW)).toBe("NO_END_DATE");
  });
  it("refuses exempt shops, shops not live, an unpaid registration fee and a zero fee", () => {
    expect(renewalRefusal({ ...base, status: st(10, { state: "EXEMPT" }) }, rule, NOW)).toBe("EXEMPT");
    expect(renewalRefusal({ ...base, shopStatus: "INACTIVE", status: st(10) }, rule, NOW)).toBe("NOT_LIVE");
    expect(renewalRefusal({ ...base, registrationFeeDuePaise: 100, status: st(10) }, rule, NOW)).toBe("REGISTRATION_FEE_DUE");
    expect(renewalRefusal({ ...base, totalPaise: 0, status: st(10) }, rule, NOW)).toBe("NOTHING_TO_PAY");
  });
});

describe("reminder stages", () => {
  const rule = { reminderDays: 30, graceDays: 15 };
  // Ends at 18.30 UTC = midnight IST of the next day, as many memberships do.
  const endsIn = (days: number) => new Date(NOW.getTime() + days * DAY);
  it("30 / 7 / 1 / 0 days before, the most urgent reached (a missed day still sends the next)", () => {
    expect(reminderStageFor(endsIn(45), NOW, rule)).toBeNull();
    expect(reminderStageFor(endsIn(30), NOW, rule)).toBe("D30");
    expect(reminderStageFor(endsIn(12), NOW, rule)).toBe("D30");
    expect(reminderStageFor(endsIn(7), NOW, rule)).toBe("D7");
    expect(reminderStageFor(endsIn(5), NOW, rule)).toBe("D7");
    expect(reminderStageFor(endsIn(1), NOW, rule)).toBe("D1");
    expect(reminderStageFor(endsIn(0), NOW, rule)).toBe("D0");
  });
  it("after the end: one notice when the grace ends (up to 3 days late), nothing in between", () => {
    expect(reminderStageFor(endsIn(-3), NOW, rule)).toBeNull();
    expect(reminderStageFor(endsIn(-15), NOW, rule)).toBe("GRACE_END");
    expect(reminderStageFor(endsIn(-18), NOW, rule)).toBe("GRACE_END");
    expect(reminderStageFor(endsIn(-19), NOW, rule)).toBeNull();
  });
  it("a reminderDays below 7 drops the longer stages", () => {
    expect(reminderStageFor(endsIn(5), NOW, { reminderDays: 3, graceDays: 0 })).toBeNull();
    expect(reminderStageFor(endsIn(3), NOW, { reminderDays: 3, graceDays: 0 })).toBe("D3");
  });
});

describe("report CSV", () => {
  it("masks mobiles and neutralises formula cells", () => {
    const row: MembershipReportRow = {
      shopId: "s",
      shopName: "=HYPERLINK(\"x\")",
      registrationNumber: "GK-1",
      shopType: "DAIRY",
      shopStatus: "APPROVED",
      phone: "9876543210",
      city: "Pune, MH",
      validUntil: new Date("2027-04-01T00:00:00Z"),
      state: "DUE_SOON",
      enforced: true,
      exempt: false,
      manualExempt: false,
      exemptReason: null,
      exemptSetAt: null,
      lastRenewalAt: null,
    };
    const [header, line] = membershipReportCsv([row]).trim().split("\n");
    expect(header.startsWith("Shop,Registration no.")).toBe(true);
    expect(line).toContain("******3210");
    expect(line).not.toContain("9876543210");
    expect(line.startsWith(`"'=HYPERLINK`)).toBe(true);
    expect(line).toContain('"Pune, MH"');
    expect(line).toContain("2027-04-01");
  });
});
