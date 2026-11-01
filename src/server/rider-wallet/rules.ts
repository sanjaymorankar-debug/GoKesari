/**
 * Pure rules of rider bank payouts (docs/gig-bank-payouts-2026-10): TDS,
 * withdrawal limits and the monthly window. No database here, so the unit
 * tests cover every edge.
 *
 * Owner decisions, 31 Oct 2026 (rule riderPayouts holds the live values):
 *   - withdrawals ₹100–₹10,000 each and ₹10,000 a day, no fee;
 *   - monthly payout on the 5th from 09:00 IST, ₹100 minimum, less carried forward;
 *   - TDS s.194C: 1% (20% without PAN) once a rider's payments in the financial
 *     year pass ₹1,00,000 — on the year's total, less TDS already deducted — or
 *     on a single payment above ₹30,000.
 */
import { formatPaise } from "@/lib/money";

export interface TdsRule {
  tdsEnabled: boolean;
  tdsRatePanBp: number;
  tdsRateNoPanBp: number;
  singlePaymentThresholdPaise: number;
  annualThresholdPaise: number;
}

export interface TdsInput {
  /** This payment, before TDS and fee. */
  grossPaise: number;
  /** The rider's payments already made or drafted in this financial year (this one excluded). */
  paidThisYearPaise: number;
  /** TDS already deducted from them this financial year. */
  tdsThisYearPaise: number;
  hasPan: boolean;
  /** What may be deducted at most (gross − fee − ₹1: the bank needs a positive amount). */
  maxPaise: number;
}

export interface TdsResult {
  tdsPaise: number;
  rateBp: number;
  /** Why (for the statement): NONE, BELOW_THRESHOLD, SINGLE_PAYMENT, ANNUAL_THRESHOLD. */
  basis: "NONE" | "BELOW_THRESHOLD" | "SINGLE_PAYMENT" | "ANNUAL_THRESHOLD";
}

export function computeTds(rule: TdsRule, input: TdsInput): TdsResult {
  if (!rule.tdsEnabled) return { tdsPaise: 0, rateBp: 0, basis: "NONE" };
  const rateBp = input.hasPan ? rule.tdsRatePanBp : rule.tdsRateNoPanBp;
  const yearAfter = input.paidThisYearPaise + input.grossPaise;
  let due = 0;
  let basis: TdsResult["basis"] = "BELOW_THRESHOLD";
  if (yearAfter > rule.annualThresholdPaise) {
    // Past the annual limit: TDS is due on the whole year, earlier payments included.
    due = Math.round((yearAfter * rateBp) / 10_000) - input.tdsThisYearPaise;
    basis = "ANNUAL_THRESHOLD";
  } else if (input.grossPaise > rule.singlePaymentThresholdPaise) {
    due = Math.round((input.grossPaise * rateBp) / 10_000);
    basis = "SINGLE_PAYMENT";
  }
  // Whatever cannot be deducted now stays due: the next payment's sum picks it up.
  const tdsPaise = Math.max(0, Math.min(due, input.maxPaise));
  if (tdsPaise === 0) return { tdsPaise: 0, rateBp: 0, basis: basis === "BELOW_THRESHOLD" ? basis : "NONE" };
  return { tdsPaise, rateBp, basis };
}

/** Financial year (1 April – 31 March, IST) of an instant: [start, end). */
export function financialYearBounds(now: Date): { start: Date; end: Date; label: string } {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return {
    start: new Date(`${y}-04-01T00:00:00+05:30`),
    end: new Date(`${y + 1}-04-01T00:00:00+05:30`),
    label: `${y}-${String((y + 1) % 100).padStart(2, "0")}`,
  };
}

export interface WithdrawalRule {
  withdrawalMinPaise: number;
  withdrawalMaxPaise: number;
  withdrawalDailyMaxPaise: number;
  withdrawalFeePaise: number;
}

/** Why an amount cannot be withdrawn, or null when it can. */
export function withdrawalProblem(
  rule: WithdrawalRule,
  input: { amountPaise: number; availablePaise: number; withdrawnTodayPaise: number },
): string | null {
  const { amountPaise, availablePaise, withdrawnTodayPaise } = input;
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) return "Enter the amount to withdraw.";
  if (amountPaise < rule.withdrawalMinPaise) return `The smallest withdrawal is ${formatPaise(rule.withdrawalMinPaise)}.`;
  if (amountPaise > rule.withdrawalMaxPaise) return `The largest withdrawal is ${formatPaise(rule.withdrawalMaxPaise)}.`;
  if (amountPaise > availablePaise) return `You can withdraw up to ${formatPaise(Math.max(availablePaise, 0))} — your unpaid earnings.`;
  const leftToday = rule.withdrawalDailyMaxPaise - withdrawnTodayPaise;
  if (amountPaise > leftToday) {
    return leftToday > 0
      ? `You can withdraw ${formatPaise(leftToday)} more today (daily limit ${formatPaise(rule.withdrawalDailyMaxPaise)}).`
      : `You have reached today's withdrawal limit of ${formatPaise(rule.withdrawalDailyMaxPaise)}. Try again tomorrow.`;
  }
  if (amountPaise - rule.withdrawalFeePaise <= 0) return "The amount must be more than the fee.";
  return null;
}

/* ----------------------------------------------------------------- months */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10" → "October 2026". */
export function monthLabel(month: string): string {
  return `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** The IST calendar date and hour of an instant. */
export function istParts(now: Date): { year: number; month: number; day: number; hour: number } {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate(), hour: ist.getUTCHours() };
}

/** The month before the IST month `now` is in, as YYYY-MM. */
export function previousMonthOf(now: Date): string {
  const { year, month } = istParts(now);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

/** [start, end) of a YYYY-MM month in IST. */
export function monthWindow(month: string): { start: Date; end: Date } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { start: new Date(`${month}-01T00:00:00+05:30`), end: new Date(`${next}-01T00:00:00+05:30`) };
}

/**
 * Is it payout time? On the payout day from the payout hour (IST). Later the
 * same day still counts (an hourly job that missed 09:00 catches up), and so
 * do the next days of the month: a run that never started on the 5th — the
 * site was down — starts on the 6th. The run row makes it happen once.
 */
export function isPayoutTime(rule: { payoutDayOfMonth: number; payoutHourIst: number }, now: Date): boolean {
  const { day, hour } = istParts(now);
  if (day < rule.payoutDayOfMonth) return false;
  return day > rule.payoutDayOfMonth || hour >= rule.payoutHourIst;
}
