/**
 * Rider Pay Plans (Rider App v2, docs/rider-app-v2-2026-11) — the per-delivery pay formula as pure
 * functions: no database, so every rule is unit-tested on its own. Money in paise, distance in
 * metres, time in minutes. The service (server/services/rider-pay-plans.ts) loads the plan and the
 * surges and stores the result.
 *
 *   P = rider → shop (first mile), D = shop → customer (last mile), road distances at offer time.
 *
 *   BasePay       = base fee (covers the first baseIncludedM of D)
 *   LastMilePay   = Σ slabs of D beyond baseIncludedM × slab rate
 *   FirstMilePay  = min(max(0, P − freeFirstMileM) × firstMileRate, firstMileCap)
 *   ExtraDropPay  = per extra drop in the same trip: extraDropFee + slab pay on the extra leg
 *   LongDistBonus = bonus when D ≥ longDistanceM
 *   Subtotal      = Base + LastMile + FirstMile + ExtraDrop + LongDist
 *   SurgePay      = Subtotal × (highest multiplier − 1) + Σ flat add-ons
 *   OrderPay      = min(max(minGuarantee, Subtotal + Surge), maxPerOrder), rounded UP to ₹1
 *   QUOTE         = OrderPay — locked when the rider accepts
 *
 *   FINAL = max(QUOTE, re-worked pay when the leg grew more than rerouteTolerancePct)
 *           + WaitPay + incentives − deductions (incentives / deductions: lib/earnings-calc.ts)
 *   WaitPay = min(max(0, wait − freeWaitMin) × waitRate, waitCap)
 */

/** A band of the shop → customer leg, [fromM, toM) metres, paid at ratePaise per km. toM null = no upper end. */
export interface PaySlab {
  fromM: number;
  toM: number | null;
  ratePaise: number;
}

export interface PayPlanTerms {
  id?: string | null;
  version?: number | null;
  baseFeePaise: number;
  baseIncludedM: number;
  slabs: PaySlab[];
  freeFirstMileM: number;
  firstMileRatePaise: number;
  firstMileCapPaise: number;
  freeWaitMin: number;
  waitRatePaise: number;
  waitCapPaise: number;
  extraDropFeePaise: number;
  longDistanceM: number | null;
  longDistanceBonusPaise: number;
  minGuaranteePaise: number;
  maxPerOrderPaise: number | null;
  rerouteTolerancePct: number;
}

/** One reason the pay is boosted right now: a peak slot, rain, a festival, a manual zone switch. */
export interface SurgeSource {
  label: string;
  /** 10000 = ×1.0, 12000 = ×1.2. */
  multiplierBp: number;
  flatPaise: number;
}

export interface QuoteInput {
  /** Shop → customer, metres. */
  legM: number;
  /** Rider → shop, metres (0 when unknown). */
  firstMileM: number;
  /** Each extra drop's own leg in the same trip, metres. */
  extraLegsM?: number[];
}

export interface PayQuote {
  planId: string | null;
  planVersion: number | null;
  legM: number;
  firstMileM: number;
  basePaise: number;
  lastMilePaise: number;
  firstMilePaise: number;
  extraDropPaise: number;
  longDistancePaise: number;
  subtotalPaise: number;
  surgeMultiplierBp: number;
  surgeFlatPaise: number;
  surgePaise: number;
  surgeLabels: string[];
  /** Added to reach the minimum guarantee (0 when not needed). */
  minTopUpPaise: number;
  /** Taken off by the per-order cap (0 when not reached). */
  capCutPaise: number;
  /** Added by rounding up to the next whole rupee. */
  roundingPaise: number;
  quotePaise: number;
}

const nonNeg = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
/** Rounds to whole paise first (so 5400.0000001 stays 5400), then up to the next ₹1. */
export const roundUpToRupee = (paise: number) => Math.ceil(Math.round(paise) / 100) * 100;

/** Pay for the part of a leg that lies in [fromM, toM) across the slabs. */
function slabPay(slabs: readonly PaySlab[], fromM: number, toM: number): number {
  if (toM <= fromM) return 0;
  let paise = 0;
  for (const slab of slabs) {
    const lo = Math.max(fromM, slab.fromM);
    const hi = Math.min(toM, slab.toM ?? Number.POSITIVE_INFINITY);
    if (hi > lo) paise += ((hi - lo) * slab.ratePaise) / 1000;
  }
  return paise;
}

/** Slab pay for an extra drop's whole leg: distance below the first slab is paid at the first slab's rate. */
export function extraLegPay(slabs: readonly PaySlab[], legM: number): number {
  const leg = nonNeg(legM);
  if (slabs.length === 0 || leg === 0) return 0;
  const first = slabs[0];
  const head = Math.min(leg, first.fromM);
  return (head * first.ratePaise) / 1000 + slabPay(slabs, first.fromM, leg);
}

/** Highest multiplier wins; flat add-ons are added together. */
export function combineSurges(sources: readonly SurgeSource[]): { multiplierBp: number; flatPaise: number; labels: string[] } {
  const active = sources.filter((s) => s.multiplierBp > 10000 || s.flatPaise > 0);
  return {
    multiplierBp: active.reduce((m, s) => Math.max(m, s.multiplierBp), 10000),
    flatPaise: active.reduce((n, s) => n + nonNeg(s.flatPaise), 0),
    labels: active.map((s) => s.label),
  };
}

export function computeQuote(plan: PayPlanTerms, input: QuoteInput, surges: readonly SurgeSource[] = []): PayQuote {
  const legM = Math.round(nonNeg(input.legM));
  const firstMileM = Math.round(nonNeg(input.firstMileM));

  const base = plan.baseFeePaise;
  const lastMile = slabPay(plan.slabs, plan.baseIncludedM, legM);
  const firstMile = Math.min((nonNeg(firstMileM - plan.freeFirstMileM) * plan.firstMileRatePaise) / 1000, plan.firstMileCapPaise);
  const extraDrop = (input.extraLegsM ?? []).reduce((n, leg) => n + plan.extraDropFeePaise + extraLegPay(plan.slabs, leg), 0);
  const longDistance = plan.longDistanceM != null && plan.longDistanceM > 0 && legM >= plan.longDistanceM ? plan.longDistanceBonusPaise : 0;
  const subtotal = base + lastMile + firstMile + extraDrop + longDistance;

  const surge = combineSurges(surges);
  const surgePay = (subtotal * (surge.multiplierBp - 10000)) / 10000 + surge.flatPaise;
  const raw = Math.round(subtotal + surgePay);

  const withMin = Math.max(plan.minGuaranteePaise, raw);
  const minTopUp = withMin - raw;
  const rounded = roundUpToRupee(withMin);
  const capped = plan.maxPerOrderPaise != null ? Math.min(rounded, plan.maxPerOrderPaise) : rounded;
  const capCut = Math.max(0, withMin - capped);
  const rounding = Math.max(0, capped - withMin);

  return {
    planId: plan.id ?? null,
    planVersion: plan.version ?? null,
    legM,
    firstMileM,
    basePaise: Math.round(base),
    lastMilePaise: Math.round(lastMile),
    firstMilePaise: Math.round(firstMile),
    extraDropPaise: Math.round(extraDrop),
    longDistancePaise: Math.round(longDistance),
    subtotalPaise: Math.round(subtotal),
    surgeMultiplierBp: surge.multiplierBp,
    surgeFlatPaise: surge.flatPaise,
    surgePaise: Math.round(surgePay),
    surgeLabels: surge.labels,
    minTopUpPaise: minTopUp,
    capCutPaise: capCut,
    roundingPaise: rounding,
    quotePaise: capped,
  };
}

export function computeWaitPay(plan: Pick<PayPlanTerms, "freeWaitMin" | "waitRatePaise" | "waitCapPaise">, waitMin: number): number {
  return Math.round(Math.min(nonNeg(Math.floor(nonNeg(waitMin)) - plan.freeWaitMin) * plan.waitRatePaise, plan.waitCapPaise));
}

export interface FinalPayInput {
  /** The quote locked at acceptance. */
  quote: PayQuote;
  /** The leg actually ridden (or the new address's leg), metres; null = unchanged. */
  actualLegM: number | null;
  /** Minutes waited at the shop (arrived → picked up). */
  waitMin: number;
}

export interface FinalPay {
  /** max(quote, re-worked pay) — the trip part before wait, incentives and deductions. */
  tripPaise: number;
  reroutedPaise: number | null;
  rerouted: boolean;
  waitPaise: number;
}

/**
 * The locked quote can only go up: when the leg grew more than the plan's tolerance (the customer
 * changed the address, a closed road), the pay is worked out again on the new leg with the same
 * surge, and the higher of the two is paid. Wait pay is added on top.
 */
export function computeFinalPay(plan: PayPlanTerms, input: FinalPayInput): FinalPay {
  const { quote } = input;
  let reroutedPaise: number | null = null;
  if (input.actualLegM != null && quote.legM > 0 && input.actualLegM > quote.legM * (1 + plan.rerouteTolerancePct / 100)) {
    reroutedPaise = computeQuote(
      plan,
      { legM: input.actualLegM, firstMileM: quote.firstMileM },
      [{ label: "locked", multiplierBp: quote.surgeMultiplierBp, flatPaise: quote.surgeFlatPaise }],
    ).quotePaise;
  }
  const rerouted = reroutedPaise != null && reroutedPaise > quote.quotePaise;
  return {
    tripPaise: rerouted ? (reroutedPaise as number) : quote.quotePaise,
    reroutedPaise,
    rerouted,
    waitPaise: computeWaitPay(plan, input.waitMin),
  };
}

/* ------------------------------------------------------------------ checks */

/** Problems with a plan's numbers, in plain words; empty = fine. */
export function planProblems(plan: PayPlanTerms): string[] {
  const problems: string[] = [];
  const amounts: [string, number | null][] = [
    ["Base fee", plan.baseFeePaise],
    ["Base distance", plan.baseIncludedM],
    ["Free first mile", plan.freeFirstMileM],
    ["First-mile rate", plan.firstMileRatePaise],
    ["First-mile cap", plan.firstMileCapPaise],
    ["Free wait", plan.freeWaitMin],
    ["Wait rate", plan.waitRatePaise],
    ["Wait cap", plan.waitCapPaise],
    ["Extra-drop fee", plan.extraDropFeePaise],
    ["Long-distance bonus", plan.longDistanceBonusPaise],
    ["Minimum guarantee", plan.minGuaranteePaise],
    ["Per-order cap", plan.maxPerOrderPaise],
    ["Long-distance threshold", plan.longDistanceM],
  ];
  for (const [label, value] of amounts) {
    if (value != null && (!Number.isInteger(value) || value < 0)) problems.push(`${label} must be a whole number, zero or more.`);
  }
  if (!Number.isInteger(plan.rerouteTolerancePct) || plan.rerouteTolerancePct < 0 || plan.rerouteTolerancePct > 100) {
    problems.push("Reroute tolerance must be between 0 and 100%.");
  }
  if (plan.maxPerOrderPaise != null && plan.maxPerOrderPaise < plan.minGuaranteePaise) {
    problems.push("The per-order cap cannot be below the minimum guarantee.");
  }
  problems.push(...slabProblems(plan.slabs, plan.baseIncludedM));
  return problems;
}

/** Slabs must start where the base distance ends, follow on with no gap or overlap, and only the last may be open-ended. */
export function slabProblems(slabs: readonly PaySlab[], baseIncludedM: number): string[] {
  if (slabs.length === 0) return ["Add at least one distance slab."];
  const problems: string[] = [];
  if (slabs[0].fromM !== baseIncludedM) {
    problems.push(`The first slab must start at ${fmtKm(baseIncludedM)} km, where the base fee's distance ends.`);
  }
  slabs.forEach((slab, i) => {
    const n = i + 1;
    if (!Number.isInteger(slab.fromM) || slab.fromM < 0) problems.push(`Slab ${n}: the start must be zero or more.`);
    if (!Number.isInteger(slab.ratePaise) || slab.ratePaise < 0) problems.push(`Slab ${n}: the rate must be a whole number of paise, zero or more.`);
    if (slab.toM != null && slab.toM <= slab.fromM) problems.push(`Slab ${n}: the end must be after the start.`);
    if (slab.toM == null && i < slabs.length - 1) problems.push(`Slab ${n}: only the last slab can have no end.`);
    const next = slabs[i + 1];
    if (next && slab.toM != null && next.fromM !== slab.toM) {
      problems.push(
        next.fromM > slab.toM
          ? `Gap between slab ${n} (ends ${fmtKm(slab.toM)} km) and slab ${n + 1} (starts ${fmtKm(next.fromM)} km).`
          : `Slab ${n} and slab ${n + 1} overlap.`,
      );
    }
  });
  if (slabs[slabs.length - 1].toM != null) problems.push("The last slab must have no end, so every distance is paid.");
  return problems;
}

/* ------------------------------------------------------------------ words */

export const fmtKm = (m: number) => {
  const km = m / 1000;
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
};
export const fmtRupees = (paise: number) => {
  const r = paise / 100;
  return `₹${Number.isInteger(r) ? r : r.toFixed(2)}`;
};

/** The plan in plain English, for the admin's live preview. */
export function describePlan(plan: PayPlanTerms): string[] {
  const lines = [`${fmtRupees(plan.baseFeePaise)} base fee covers the first ${fmtKm(plan.baseIncludedM)} km to the customer.`];
  for (const s of plan.slabs) {
    lines.push(
      s.toM == null
        ? `Above ${fmtKm(s.fromM)} km: ${fmtRupees(s.ratePaise)} per km.`
        : `${fmtKm(s.fromM)}–${fmtKm(s.toM)} km: ${fmtRupees(s.ratePaise)} per km.`,
    );
  }
  if (plan.firstMileRatePaise > 0) {
    lines.push(
      `Ride to the shop: first ${fmtKm(plan.freeFirstMileM)} km free, then ${fmtRupees(plan.firstMileRatePaise)} per km, at most ${fmtRupees(plan.firstMileCapPaise)}.`,
    );
  }
  if (plan.waitRatePaise > 0) {
    lines.push(`Waiting at the shop: first ${plan.freeWaitMin} min free, then ${fmtRupees(plan.waitRatePaise)} per min, at most ${fmtRupees(plan.waitCapPaise)}.`);
  }
  if (plan.extraDropFeePaise > 0) lines.push(`Each extra drop in the same trip: ${fmtRupees(plan.extraDropFeePaise)} plus distance pay on its leg.`);
  if (plan.longDistanceM && plan.longDistanceBonusPaise > 0) {
    lines.push(`${fmtRupees(plan.longDistanceBonusPaise)} extra when the delivery is ${fmtKm(plan.longDistanceM)} km or more.`);
  }
  if (plan.minGuaranteePaise > 0) lines.push(`Never less than ${fmtRupees(plan.minGuaranteePaise)} per order.`);
  if (plan.maxPerOrderPaise != null) lines.push(`Never more than ${fmtRupees(plan.maxPerOrderPaise)} per order (before wait pay and incentives).`);
  lines.push(`Surge: the highest active multiplier applies and flat add-ons are added. The total is rounded up to the next ₹1.`);
  lines.push(`If the route grows more than ${plan.rerouteTolerancePct}% after accepting, the rider gets the higher of the quote and the new pay.`);
  return lines;
}

/** The brief's Pune pilot numbers (section 3.2) — offered as a starting point in the admin screen. */
export const PUNE_PILOT_PLAN: PayPlanTerms = {
  baseFeePaise: 2000,
  baseIncludedM: 2000,
  slabs: [
    { fromM: 2000, toM: 4000, ratePaise: 600 },
    { fromM: 4000, toM: 7000, ratePaise: 800 },
    { fromM: 7000, toM: 10000, ratePaise: 1000 },
    { fromM: 10000, toM: null, ratePaise: 1200 },
  ],
  freeFirstMileM: 1000,
  firstMileRatePaise: 300,
  firstMileCapPaise: 1500,
  freeWaitMin: 10,
  waitRatePaise: 100,
  waitCapPaise: 2000,
  extraDropFeePaise: 1000,
  longDistanceM: 8000,
  longDistanceBonusPaise: 1500,
  minGuaranteePaise: 3000,
  maxPerOrderPaise: 25000,
  rerouteTolerancePct: 15,
};
