/**
 * Rider bank payouts — pure rules (docs/gig-bank-payouts-2026-10): TDS s.194C,
 * withdrawal limits, the payout time on the 5th and the month window.
 */
import { describe, expect, it } from "vitest";

import { RULES } from "@/server/config/rules";
import {
  computeTds,
  financialYearBounds,
  isPayoutTime,
  monthLabel,
  monthWindow,
  previousMonthOf,
  withdrawalProblem,
} from "@/server/rider-wallet/rules";

const rule = RULES.riderPayouts.defaults;

describe("owner-approved defaults (31 Oct 2026)", () => {
  it("₹100–₹10,000 per withdrawal and a day, no fee, ₹100 monthly minimum, the 5th at 09:00, 3 retries, TDS 1% / 20%", () => {
    expect(rule).toMatchObject({
      withdrawalMinPaise: 10_000,
      withdrawalMaxPaise: 1_000_000,
      withdrawalDailyMaxPaise: 1_000_000,
      withdrawalFeePaise: 0,
      monthlyMinPaise: 10_000,
      payoutDayOfMonth: 5,
      payoutHourIst: 9,
      maxRetries: 3,
      tdsEnabled: true,
      tdsRatePanBp: 100,
      tdsRateNoPanBp: 2000,
      singlePaymentThresholdPaise: 3_000_000,
      annualThresholdPaise: 10_000_000,
    });
    expect(RULES.riderPayouts.schema.parse(rule)).toEqual(rule);
  });
});

describe("computeTds (s.194C)", () => {
  const base = { paidThisYearPaise: 0, tdsThisYearPaise: 0, hasPan: true, maxPaise: 1_000_000_000 };

  it("nothing below both thresholds", () => {
    expect(computeTds(rule, { ...base, grossPaise: 500_000, paidThisYearPaise: 9_000_000 })).toEqual({ tdsPaise: 0, rateBp: 0, basis: "BELOW_THRESHOLD" });
  });

  it("a single payment above ₹30,000: 1% of that payment", () => {
    expect(computeTds(rule, { ...base, grossPaise: 3_500_000 })).toEqual({ tdsPaise: 35_000, rateBp: 100, basis: "SINGLE_PAYMENT" });
  });

  it("exactly ₹30,000 is not above the threshold", () => {
    expect(computeTds(rule, { ...base, grossPaise: 3_000_000 }).tdsPaise).toBe(0);
  });

  it("crossing ₹1,00,000 in the year: 1% of the whole year, catching up earlier payments", () => {
    // ₹95,000 paid before, ₹10,000 now → ₹1,05,000 → ₹1,050 due.
    expect(computeTds(rule, { ...base, grossPaise: 1_000_000, paidThisYearPaise: 9_500_000 })).toEqual({ tdsPaise: 105_000, rateBp: 100, basis: "ANNUAL_THRESHOLD" });
  });

  it("after the threshold, only what is not yet deducted", () => {
    expect(computeTds(rule, { ...base, grossPaise: 1_000_000, paidThisYearPaise: 10_500_000, tdsThisYearPaise: 105_000 }).tdsPaise).toBe(10_000);
  });

  it("20% without PAN", () => {
    expect(computeTds(rule, { ...base, grossPaise: 3_500_000, hasPan: false })).toMatchObject({ tdsPaise: 700_000, rateBp: 2000 });
  });

  it("never more than the payment allows; the rest stays due for the next one", () => {
    const r = computeTds(rule, { ...base, grossPaise: 10_000, paidThisYearPaise: 20_000_000, maxPaise: 9_900 });
    expect(r.tdsPaise).toBe(9_900);
  });

  it("switched off: none", () => {
    expect(computeTds({ ...rule, tdsEnabled: false }, { ...base, grossPaise: 5_000_000 }).tdsPaise).toBe(0);
  });
});

describe("withdrawalProblem", () => {
  const ok = { availablePaise: 5_000_000, withdrawnTodayPaise: 0 };
  it("accepts an amount inside every limit", () => {
    expect(withdrawalProblem(rule, { ...ok, amountPaise: 50_000 })).toBeNull();
  });
  it.each([
    [9_999, "smallest"],
    [1_000_001, "largest"],
    [0, "Enter the amount"],
    [12.5, "Enter the amount"],
  ])("refuses %s (%s)", (amountPaise, text) => {
    expect(withdrawalProblem(rule, { ...ok, amountPaise })).toContain(text);
  });
  it("cannot exceed the unpaid balance", () => {
    expect(withdrawalProblem(rule, { amountPaise: 20_000, availablePaise: 15_000, withdrawnTodayPaise: 0 })).toContain("up to ₹150");
  });
  it("daily limit", () => {
    expect(withdrawalProblem(rule, { amountPaise: 300_000, availablePaise: 5_000_000, withdrawnTodayPaise: 800_000 })).toContain("more today");
    expect(withdrawalProblem(rule, { amountPaise: 10_000, availablePaise: 5_000_000, withdrawnTodayPaise: 1_000_000 })).toContain("reached today's");
  });
});

describe("payout time and months (IST)", () => {
  it("only on or after the 5th from 09:00 IST", () => {
    expect(isPayoutTime(rule, new Date("2026-11-05T03:29:00Z"))).toBe(false); // 08:59 IST
    expect(isPayoutTime(rule, new Date("2026-11-05T03:30:00Z"))).toBe(true); // 09:00 IST
    expect(isPayoutTime(rule, new Date("2026-11-04T20:00:00Z"))).toBe(false); // 5 Nov 01:30 IST
    expect(isPayoutTime(rule, new Date("2026-11-06T00:00:00Z"))).toBe(true); // a missed run catches up
    expect(isPayoutTime(rule, new Date("2026-11-04T12:00:00Z"))).toBe(false);
  });
  it("previous month in IST, across the year", () => {
    expect(previousMonthOf(new Date("2026-11-05T03:30:00Z"))).toBe("2026-10");
    expect(previousMonthOf(new Date("2027-01-05T03:30:00Z"))).toBe("2026-12");
    // 31 Oct 19:00 UTC is already 1 Nov in India.
    expect(previousMonthOf(new Date("2026-10-31T19:00:00Z"))).toBe("2026-10");
  });
  it("month window is IST midnight to midnight", () => {
    expect(monthWindow("2026-10")).toEqual({ start: new Date("2026-09-30T18:30:00Z"), end: new Date("2026-10-31T18:30:00Z") });
    expect(monthWindow("2026-12").end).toEqual(new Date("2026-12-31T18:30:00Z"));
    expect(monthLabel("2026-10")).toBe("October 2026");
  });
  it("financial year April–March", () => {
    expect(financialYearBounds(new Date("2026-10-31T00:00:00Z")).label).toBe("2026-27");
    expect(financialYearBounds(new Date("2027-03-31T18:00:00Z")).label).toBe("2026-27");
    expect(financialYearBounds(new Date("2027-03-31T18:30:00Z")).label).toBe("2027-28");
  });
});
