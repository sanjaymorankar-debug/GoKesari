/**
 * Rider earning calculation — pure functions, no database access, so the
 * rules can be reasoned about (and tested) on their own. The service in
 * server/services/delivery-earnings.ts gathers the inputs and persists the
 * result.
 *
 * net = base + distance + order component + slot incentive + minimum top-up
 *       + order incentive + other incentive − deductions
 */

export type Weekdays = number[]; // 0 = Sunday .. 6; empty = every day

export interface DefaultRates {
  baseFeePaise: number;
  perKmFeePaise: number;
}

export interface SlotRule {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  daysOfWeek: Weekdays;
  baseFeePaise: number | null;
  perKmFeePaise: number | null;
  minEarningPaise: number | null;
  orderFeePaise: number;
  orderPercentBp: number;
  peakBonusPaise: number;
  isPeak: boolean;
  priority: number;
  validFrom: string | null;
  validTo: string | null;
  createdAt: Date;
}

export type IncentiveType =
  | "ORDER_COUNT"
  | "DAILY_TARGET"
  | "WEEKLY_TARGET"
  | "DISTANCE"
  | "PEAK_HOUR"
  | "CAMPAIGN";

export interface IncentiveRule {
  id: string;
  name: string;
  type: IncentiveType;
  thresholdValue: number;
  rewardPaise: number;
  period: "DAY" | "WEEK";
  startTime: string | null;
  endTime: string | null;
  daysOfWeek: Weekdays;
  validFrom: string | null;
  validTo: string | null;
}

export interface EarningRules {
  minimumEarningPaise: number;
  failedDeliveryPayoutPercent: number;
  cancelledAfterPickupPayoutPercent: number;
  latePenaltyPaise: number;
  lateGraceMinutes: number;
}

export type EarningOutcome = "DELIVERED" | "FAILED" | "CANCELLED_AFTER_PICKUP";

export interface EarningInput {
  outcome: EarningOutcome;
  distanceKm: number;
  orderSubtotalPaise: number;
  /** The moment the job is dated by (slot and time-window rules look at it). */
  at: Date;
  timeZone: string;
  /** Deliveries completed by this rider in the local day / week, INCLUDING this one when DELIVERED. */
  dayCount: number;
  weekCount: number;
  /** How many minutes after the promised time the drop happened (null = no promise / not late). */
  minutesLate: number | null;
  /** `${ruleId}:${periodKey}` pairs already paid — one-off targets are not paid twice. */
  alreadyAwarded: ReadonlySet<string>;
  /** Used as the period key of per-order rewards, so each is paid once per delivery. */
  deliveryOrderId: string;
}

export interface Award {
  ruleId: string;
  name: string;
  type: IncentiveType;
  amountPaise: number;
  periodKey: string;
  bucket: "ORDER" | "SLOT" | "OTHER";
}

export interface LedgerLine {
  component:
    | "BASE"
    | "DISTANCE"
    | "ORDER_COMPONENT"
    | "SLOT_INCENTIVE"
    | "MIN_TOP_UP"
    | "ORDER_INCENTIVE"
    | "OTHER_INCENTIVE"
    | "DEDUCTION";
  amountPaise: number;
  description: string;
}

export interface EarningBreakdown {
  basePaise: number;
  distancePaise: number;
  orderComponentPaise: number;
  slotIncentivePaise: number;
  minTopUpPaise: number;
  orderIncentivePaise: number;
  otherIncentivePaise: number;
  deductionsPaise: number;
  totalPaise: number;
  slotId: string | null;
  slotName: string | null;
  awards: Award[];
  lines: LedgerLine[];
}

/* ------------------------------------------------------------ local time */

export interface LocalTime {
  dateKey: string; // YYYY-MM-DD
  weekKey: string; // YYYY-Www (ISO)
  minutes: number; // minutes since local midnight
  weekday: number; // 0 = Sunday
}

export function localTime(at: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24; // some engines report 24 at midnight
  const minute = Number(get("minute"));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const dateKey = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { dateKey, weekKey: isoWeekKey(year, month, day), minutes: hour * 60 + minute, weekday };
}

function isoWeekKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNum = date.getUTCDay() || 7; // Monday = 1 .. Sunday = 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // the Thursday of this ISO week
  const isoYear = date.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export function parseHHMM(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** [start, end) in minutes; end < start wraps past midnight. */
export function inWindow(minutes: number, startTime: string | null, endTime: string | null): boolean {
  if (!startTime || !endTime) return true;
  const start = parseHHMM(startTime);
  const end = parseHHMM(endTime);
  if (start == null || end == null || start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function activeOn(rule: { daysOfWeek: Weekdays; validFrom: string | null; validTo: string | null }, t: LocalTime): boolean {
  if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(t.weekday)) return false;
  if (rule.validFrom && t.dateKey < rule.validFrom) return false;
  if (rule.validTo && t.dateKey > rule.validTo) return false;
  return true;
}

/** Highest-priority slot containing `at`; ties go to the most recently created. */
export function pickSlot(slots: readonly SlotRule[], at: Date, timeZone: string): SlotRule | null {
  const t = localTime(at, timeZone);
  const matching = slots.filter((s) => activeOn(s, t) && inWindow(t.minutes, s.startTime, s.endTime));
  matching.sort((a, b) => b.priority - a.priority || b.createdAt.getTime() - a.createdAt.getTime());
  return matching[0] ?? null;
}


/** The incentive rules a delivery earns (completed drops only). Shared by the flat-rate and the pay-plan paths. */
export function incentiveAwards(incentives: readonly IncentiveRule[], input: EarningInput, t: LocalTime): Award[] {
  const awards: Award[] = [];
  if (input.outcome === "DELIVERED") {
    for (const rule of incentives) {
      if (!activeOn(rule, t)) continue;
      let periodKey: string | null = null;
      let bucket: Award["bucket"] = "OTHER";
      switch (rule.type) {
        case "ORDER_COUNT": {
          const count = rule.period === "WEEK" ? input.weekCount : input.dayCount;
          if (count > rule.thresholdValue) periodKey = input.deliveryOrderId;
          bucket = "ORDER";
          break;
        }
        case "DAILY_TARGET":
          if (input.dayCount === rule.thresholdValue) periodKey = t.dateKey;
          bucket = "ORDER";
          break;
        case "WEEKLY_TARGET":
          if (input.weekCount === rule.thresholdValue) periodKey = t.weekKey;
          bucket = "ORDER";
          break;
        case "DISTANCE":
          if (input.distanceKm * 1000 >= rule.thresholdValue) periodKey = input.deliveryOrderId;
          bucket = "OTHER";
          break;
        case "PEAK_HOUR":
          if (inWindow(t.minutes, rule.startTime, rule.endTime)) periodKey = input.deliveryOrderId;
          bucket = "SLOT";
          break;
        case "CAMPAIGN":
          if (inWindow(t.minutes, rule.startTime, rule.endTime)) periodKey = input.deliveryOrderId;
          bucket = "OTHER";
          break;
      }
      if (!periodKey || input.alreadyAwarded.has(`${rule.id}:${periodKey}`)) continue;
      awards.push({ ruleId: rule.id, name: rule.name, type: rule.type, amountPaise: rule.rewardPaise, periodKey, bucket });
    }
  }
  return awards;
}

/* ------------------------------------------------------------ calculation */

const percentOf = (paise: number, percent: number) => Math.round((paise * percent) / 100);

export function calculateEarning(
  defaults: DefaultRates,
  slots: readonly SlotRule[],
  incentives: readonly IncentiveRule[],
  rules: EarningRules,
  input: EarningInput,
): EarningBreakdown {
  const t = localTime(input.at, input.timeZone);
  const slot = pickSlot(slots, input.at, input.timeZone);
  const lines: LedgerLine[] = [];
  const push = (component: LedgerLine["component"], amountPaise: number, description: string) => {
    if (amountPaise !== 0) lines.push({ component, amountPaise, description });
  };

  const basePaise = slot?.baseFeePaise ?? defaults.baseFeePaise;
  const perKm = slot?.perKmFeePaise ?? defaults.perKmFeePaise;
  const distancePaise = Math.round((Number.isFinite(input.distanceKm) ? input.distanceKm : 0) * perKm);
  const orderComponentPaise = slot
    ? slot.orderFeePaise + Math.round((input.orderSubtotalPaise * slot.orderPercentBp) / 10_000)
    : 0;
  const slotIncentivePaise = slot?.peakBonusPaise ?? 0;

  push("BASE", basePaise, slot ? `Base fee (${slot.name})` : "Base fee");
  push("DISTANCE", distancePaise, `Distance ${input.distanceKm.toFixed(1)} km`);
  push("ORDER_COMPONENT", orderComponentPaise, "Order-based component");
  push("SLOT_INCENTIVE", slotIncentivePaise, slot ? `${slot.isPeak ? "Peak" : "Slot"} bonus (${slot.name})` : "Slot bonus");

  let subtotal = basePaise + distancePaise + orderComponentPaise + slotIncentivePaise;
  const floor = slot?.minEarningPaise ?? rules.minimumEarningPaise;
  const minTopUpPaise = Math.max(0, floor - subtotal);
  push("MIN_TOP_UP", minTopUpPaise, `Top-up to the minimum earning of ₹${(floor / 100).toFixed(2)}`);
  subtotal += minTopUpPaise;

  // What the rider is paid for a trip that did not end in a normal drop.
  let deductionsPaise = 0;
  const payoutPercent =
    input.outcome === "FAILED"
      ? rules.failedDeliveryPayoutPercent
      : input.outcome === "CANCELLED_AFTER_PICKUP"
        ? rules.cancelledAfterPickupPayoutPercent
        : 100;
  if (payoutPercent < 100) {
    const cut = subtotal - percentOf(subtotal, payoutPercent);
    deductionsPaise += cut;
    push("DEDUCTION", -cut, `Only ${payoutPercent}% paid for a ${input.outcome === "FAILED" ? "failed delivery" : "cancelled order"}`);
  }
  if (input.outcome === "DELIVERED" && rules.latePenaltyPaise > 0 && input.minutesLate != null && input.minutesLate > rules.lateGraceMinutes) {
    const penalty = Math.min(rules.latePenaltyPaise, subtotal - deductionsPaise);
    deductionsPaise += penalty;
    push("DEDUCTION", -penalty, `Late by ${Math.round(input.minutesLate)} min`);
  }

  // Incentives reward completed deliveries only.
  const awards = incentiveAwards(incentives, input, t);

  const sumBucket = (bucket: Award["bucket"]) =>
    awards.filter((a) => a.bucket === bucket).reduce((n, a) => n + a.amountPaise, 0);
  const orderIncentivePaise = sumBucket("ORDER");
  const otherIncentivePaise = sumBucket("OTHER");
  // Peak-hour rule rewards sit with the slot incentive in the breakdown.
  const peakRuleTotal = sumBucket("SLOT");
  for (const a of awards) {
    push(
      a.bucket === "ORDER" ? "ORDER_INCENTIVE" : a.bucket === "SLOT" ? "SLOT_INCENTIVE" : "OTHER_INCENTIVE",
      a.amountPaise,
      `Incentive: ${a.name}`,
    );
  }

  const slotIncentiveTotal = slotIncentivePaise + peakRuleTotal;
  const totalPaise = Math.max(
    0,
    basePaise +
      distancePaise +
      orderComponentPaise +
      slotIncentiveTotal +
      minTopUpPaise +
      orderIncentivePaise +
      otherIncentivePaise -
      deductionsPaise,
  );

  return {
    basePaise,
    distancePaise,
    orderComponentPaise,
    slotIncentivePaise: slotIncentiveTotal,
    minTopUpPaise,
    orderIncentivePaise,
    otherIncentivePaise,
    deductionsPaise,
    totalPaise,
    slotId: slot?.id ?? null,
    slotName: slot?.name ?? null,
    awards,
    lines,
  };
}

/* ------------------------------------------------------- pay-plan earning */

/**
 * Rider App v2 (rule riderPayPlans): the earning for a delivery whose pay was quoted from a pay
 * plan and locked at acceptance (lib/rider-pay-plan.ts). The trip part is the locked quote (or the
 * higher re-worked pay after a long reroute), wait pay is added, then the same incentive rules and
 * deductions as the flat-rate path. A failed or cancelled-after-pickup trip pays the rule's
 * percentage of the QUOTE. The ledger lines sum to the total.
 */
export interface PlanTripInput {
  quote: import("./rider-pay-plan").PayQuote;
  /** max(quote, re-worked pay). */
  tripPaise: number;
  waitPaise: number;
  waitMin: number;
  planLabel: string;
}

export function calculatePlanEarning(
  trip: PlanTripInput,
  incentives: readonly IncentiveRule[],
  rules: EarningRules,
  input: EarningInput,
): EarningBreakdown {
  const t = localTime(input.at, input.timeZone);
  const q = trip.quote;
  const lines: LedgerLine[] = [];
  const push = (component: LedgerLine["component"], amountPaise: number, description: string) => {
    if (amountPaise !== 0) lines.push({ component, amountPaise, description });
  };
  const km = (m: number) => (m / 1000).toFixed(1);

  push("BASE", q.basePaise, `Base fee (${trip.planLabel})`);
  push("DISTANCE", q.lastMilePaise, `Distance to customer ${km(q.legM)} km`);
  push("DISTANCE", q.firstMilePaise, `Ride to shop ${km(q.firstMileM)} km`);
  push("DISTANCE", q.extraDropPaise, "Extra drop in the same trip");
  push("DISTANCE", q.longDistancePaise, "Long-distance bonus");
  push("SLOT_INCENTIVE", q.surgePaise, q.surgeLabels.length ? `Surge (${q.surgeLabels.join(", ")})` : "Surge");
  push("MIN_TOP_UP", q.minTopUpPaise, "Top-up to the minimum per order");
  push("MIN_TOP_UP", q.roundingPaise, "Rounded up to the next ₹1");
  push("DISTANCE", -q.capCutPaise, "Per-order cap");
  const uplift = trip.tripPaise - q.quotePaise;
  push("DISTANCE", uplift, "Route grew after accepting — re-worked pay");

  // Column totals (the ledger lines above sum to tripPaise).
  const basePaise = q.basePaise;
  const slotSurge = q.surgePaise;
  const minTopUpPaise = q.minTopUpPaise + q.roundingPaise;
  const distancePaise = trip.tripPaise - basePaise - slotSurge - minTopUpPaise;

  let deductionsPaise = 0;
  const payoutPercent =
    input.outcome === "FAILED"
      ? rules.failedDeliveryPayoutPercent
      : input.outcome === "CANCELLED_AFTER_PICKUP"
        ? rules.cancelledAfterPickupPayoutPercent
        : 100;
  // Wait pay is earned before the drop, so it is paid whatever the outcome.
  const waitPaise = trip.waitPaise;
  push("OTHER_INCENTIVE", waitPaise, `Wait at shop ${Math.round(trip.waitMin)} min`);
  if (payoutPercent < 100) {
    const base = input.outcome === "DELIVERED" ? trip.tripPaise : q.quotePaise;
    const cut = trip.tripPaise - percentOf(base, payoutPercent);
    deductionsPaise += cut;
    push("DEDUCTION", -cut, `Only ${payoutPercent}% of the quote paid for a ${input.outcome === "FAILED" ? "failed delivery" : "cancelled order"}`);
  }
  if (input.outcome === "DELIVERED" && rules.latePenaltyPaise > 0 && input.minutesLate != null && input.minutesLate > rules.lateGraceMinutes) {
    const penalty = Math.min(rules.latePenaltyPaise, trip.tripPaise - deductionsPaise);
    deductionsPaise += penalty;
    push("DEDUCTION", -penalty, `Late by ${Math.round(input.minutesLate)} min`);
  }

  const awards = incentiveAwards(incentives, input, t);
  const sumBucket = (bucket: Award["bucket"]) => awards.filter((a) => a.bucket === bucket).reduce((n, a) => n + a.amountPaise, 0);
  for (const a of awards) {
    push(a.bucket === "ORDER" ? "ORDER_INCENTIVE" : a.bucket === "SLOT" ? "SLOT_INCENTIVE" : "OTHER_INCENTIVE", a.amountPaise, `Incentive: ${a.name}`);
  }
  const orderIncentivePaise = sumBucket("ORDER");
  const otherIncentivePaise = sumBucket("OTHER") + waitPaise;
  const slotIncentivePaise = slotSurge + sumBucket("SLOT");

  const totalPaise = Math.max(
    0,
    basePaise + distancePaise + slotIncentivePaise + minTopUpPaise + orderIncentivePaise + otherIncentivePaise - deductionsPaise,
  );
  return {
    basePaise,
    distancePaise,
    orderComponentPaise: 0,
    slotIncentivePaise,
    minTopUpPaise,
    orderIncentivePaise,
    otherIncentivePaise,
    deductionsPaise,
    totalPaise,
    slotId: null,
    slotName: null,
    awards,
    lines,
  };
}
