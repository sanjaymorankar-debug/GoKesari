/**
 * Rider growth (Rider App v2, docs/rider-app-v2-2026-11): the pure parts of Refer & Earn, the
 * tier badge and slot booking. No database or server imports, so the unit tests and the client
 * pages can share them.
 */
import { localTime, parseHHMM } from "@/lib/earnings-calc";

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ dates */

/** YYYY-MM-DD + n days (calendar arithmetic, no time zone involved). */
export function addDaysKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) of a calendar date. */
export function weekdayOfKey(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The instant at which the wall clock in `timeZone` reads `dateKey` + `minutes` after midnight. */
export function zonedInstant(dateKey: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) + minutes * 60_000;
  const seen = localTime(new Date(guess), timeZone);
  const [sy, sm, sd] = seen.dateKey.split("-").map(Number);
  const seenAsUtc = Date.UTC(sy, sm - 1, sd) + seen.minutes * 60_000;
  return new Date(guess - (seenAsUtc - guess));
}

/* ------------------------------------------------------------- slot maths */

export interface BookableSlotRule {
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  bookable: boolean;
}

/** Whether the slot runs on that calendar date (the date its window starts). */
export function slotRunsOn(slot: BookableSlotRule, dateKey: string): boolean {
  if (!slot.isActive || !slot.bookable) return false;
  if (parseHHMM(slot.startTime) == null || parseHHMM(slot.endTime) == null || slot.startTime === slot.endTime) return false;
  if (slot.daysOfWeek.length > 0 && !slot.daysOfWeek.includes(weekdayOfKey(dateKey))) return false;
  if (slot.validFrom && dateKey < slot.validFrom) return false;
  if (slot.validTo && dateKey > slot.validTo) return false;
  return true;
}

/** Start and end instants of the slot's window on `dateKey`; an end before the start crosses midnight. */
export function slotWindow(slot: Pick<BookableSlotRule, "startTime" | "endTime">, dateKey: string, timeZone: string): { start: Date; end: Date } {
  const startMin = parseHHMM(slot.startTime) ?? 0;
  const endMin = parseHHMM(slot.endTime) ?? 0;
  const start = zonedInstant(dateKey, startMin, timeZone);
  const end = zonedInstant(endMin > startMin ? dateKey : addDaysKey(dateKey, 1), endMin, timeZone);
  return { start, end };
}

/** The dates a rider may book: today and the next daysAhead − 1 days (local calendar). */
export function bookableDates(now: Date, daysAhead: number, timeZone: string): string[] {
  const today = localTime(now, timeZone).dateKey;
  return Array.from({ length: Math.max(1, daysAhead) }, (_, i) => addDaysKey(today, i));
}

/** A booking may be cancelled until cancelCutoffMinutes before the slot starts. */
export function canCancel(start: Date, now: Date, cancelCutoffMinutes: number): boolean {
  return now.getTime() <= start.getTime() - cancelCutoffMinutes * 60_000;
}

/** A slot may be booked until it ends (a running slot still gives priority for the rest of it). */
export function canBook(end: Date, now: Date): boolean {
  return now.getTime() < end.getTime();
}

/** Whether a reminder is due: the slot starts within reminderMinutes from now (and has not started). */
export function reminderDue(start: Date, now: Date, reminderMinutes: number): boolean {
  const ms = start.getTime() - now.getTime();
  return ms > 0 && ms <= reminderMinutes * 60_000;
}

export interface SlotPayFields {
  surgeMultiplierBp: number | null;
  peakBonusPaise: number;
  baseFeePaise: number | null;
  perKmFeePaise: number | null;
  minEarningPaise: number | null;
}

const rupees = (paise: number) => `₹${paise % 100 === 0 ? paise / 100 : (paise / 100).toFixed(2)}`;

/** Short pay boost tags for a slot ("×1.2 pay", "+₹20 per order", …). Empty = normal pay. */
export function slotBoostTags(slot: SlotPayFields): string[] {
  const tags: string[] = [];
  if (slot.surgeMultiplierBp != null && slot.surgeMultiplierBp > 10000) {
    tags.push(`×${(slot.surgeMultiplierBp / 10000).toFixed(2).replace(/\.?0+$/, "")} pay`);
  }
  if (slot.peakBonusPaise > 0) tags.push(`+${rupees(slot.peakBonusPaise)} per order`);
  if (slot.baseFeePaise != null) tags.push(`Base ${rupees(slot.baseFeePaise)}`);
  if (slot.perKmFeePaise != null) tags.push(`${rupees(slot.perKmFeePaise)}/km`);
  if (slot.minEarningPaise != null && slot.minEarningPaise > 0) tags.push(`Min ${rupees(slot.minEarningPaise)} per order`);
  return tags;
}

/* ------------------------------------------------------------------ tiers */

export interface TierRule {
  name: string;
  minDeliveries: number;
  minRatingX100: number;
  minAcceptancePct: number;
  minOnTimePct: number;
  extraIncentivePct: number;
  priority: boolean;
}

/**
 * Last-7-day metrics. A null acceptance / on-time % means no offers / no promised deliveries in
 * the period: nothing was turned down or late, so it counts as 100 % against a minimum (the
 * deliveries minimum still applies). A rider with no ratings has rating 0.
 */
export interface TierMetrics {
  deliveries: number;
  ratingX100: number;
  ratingCount: number;
  acceptancePct: number | null;
  onTimePct: number | null;
}

export type TierMetric = "deliveries" | "rating" | "acceptance" | "onTime";

export interface TierNeed {
  metric: TierMetric;
  have: number;
  need: number;
}

function needsFor(tier: TierRule, m: TierMetrics): TierNeed[] {
  const checks: TierNeed[] = [
    { metric: "deliveries", have: m.deliveries, need: tier.minDeliveries },
    { metric: "rating", have: m.ratingX100, need: tier.minRatingX100 },
    { metric: "acceptance", have: m.acceptancePct ?? 100, need: tier.minAcceptancePct },
    { metric: "onTime", have: m.onTimePct ?? 100, need: tier.minOnTimePct },
  ];
  return checks.filter((c) => c.have < c.need);
}

export interface TierPick {
  tier: TierRule | null;
  next: { name: string; needs: TierNeed[] } | null;
}

/**
 * Tiers are listed lowest first (the rule's order). The rider holds the highest tier whose every
 * minimum is met; `next` is the tier after it, with only the minimums not yet met.
 */
export function pickTier(tiers: readonly TierRule[], metrics: TierMetrics): TierPick {
  let index = -1;
  tiers.forEach((t, i) => {
    if (needsFor(t, metrics).length === 0) index = i;
  });
  const tier = index >= 0 ? tiers[index] : null;
  const after = tiers[index + 1];
  return { tier, next: after ? { name: after.name, needs: needsFor(after, metrics) } : null };
}

/** Whole-number percentage, or null when there is nothing to measure. */
export function pct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/* --------------------------------------------------------------- referral */

/** Reserved prefix + 6 characters without look-alikes (0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const RIDER_REFERRAL_PREFIX = "GKR";

export function newReferralCode(random: () => number = Math.random): string {
  let s = RIDER_REFERRAL_PREFIX;
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

/** Normalises what the rider typed or the ?ref= link carried; null when it cannot be a rider code. */
export function normaliseReferralCode(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
  return /^GKR[A-Z0-9]{6}$/.test(v) ? v : null;
}

export type ReferralState = "PENDING" | "QUALIFIED" | "EXPIRED" | "WAITING_APPROVAL";

/**
 * Where a PENDING referral stands. The window starts when the referred rider is approved and runs
 * withinDays; only deliveries inside it count (the caller counts them).
 */
export function referralState(input: {
  approvedAt: Date | null;
  withinDays: number;
  deliveriesRequired: number;
  deliveriesInWindow: number;
  now: Date;
}): { state: ReferralState; deadline: Date | null; daysLeft: number | null } {
  if (!input.approvedAt) return { state: "WAITING_APPROVAL", deadline: null, daysLeft: null };
  const deadline = new Date(input.approvedAt.getTime() + input.withinDays * DAY_MS);
  const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - input.now.getTime()) / DAY_MS));
  if (input.deliveriesInWindow >= input.deliveriesRequired) return { state: "QUALIFIED", deadline, daysLeft };
  if (input.now.getTime() > deadline.getTime()) return { state: "EXPIRED", deadline, daysLeft: 0 };
  return { state: "PENDING", deadline, daysLeft };
}
