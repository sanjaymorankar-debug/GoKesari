/**
 * The public Commission Chart (final brief 21-Nov-2026 §9): both models side by side from the live Admin config —
 * the one-time cases A1–A4 and B1–B4 (rates and amounts on the example fees) and the recurring rules — so everyone
 * sees the same rules upfront. Nothing here is a promise of earnings; future terms are never shown.
 */
import { oneTimeSplit, type CaseCode, type OneTimeRates } from "@/lib/franchise-zones";
import { franchiseConfig, oneTimeRates } from "./config";

/** The brief's example registration fees (before GST): retail ₹1,000 and wholesale ₹2,500. */
export const CHART_EXAMPLE_FEES = [
  { key: "retail", label: "Retail shop", feePaise: 100_000 },
  { key: "wholesale", label: "Wholesale shop", feePaise: 250_000 },
] as const;

const WHO: Record<CaseCode, string> = {
  A1: "Dealer himself",
  A2: "Agent directly under the Dealer",
  A3: "Agent under a Team Lead",
  A4: "Team Lead himself",
  B1: "Owner himself",
  B2: "Agent directly under the Owner",
  B3: "Agent under a Team Lead",
  B4: "Team Lead himself",
};

export interface ChartRow {
  caseCode: CaseCode;
  who: string;
  /** Rates (bp) to the registering person, the team lead and the top person. */
  directBp: number;
  leadBp: number;
  topBp: number;
  /** Amounts (paise) on each example fee. */
  amounts: { key: string; direct: number; lead: number; top: number; total: number }[];
}

export interface CommissionChart {
  rates: OneTimeRates;
  examples: typeof CHART_EXAMPLE_FEES;
  modelA: ChartRow[];
  modelB: ChartRow[];
  recurring: {
    gokesariCommissionBp: number;
    recurringBaseBp: number;
    bonusMaxBp: number;
    monthlyShopTarget: number;
    expectedBusinessPerShopPaise: number;
    businessSlotPaise: number;
    basePointsPerMainPoint: number;
    bonusBpPerMainPoint: number;
    tailYears: number;
    validityMonths: number;
    maxOwnersPerZone: number;
  };
}

export async function commissionChart(): Promise<CommissionChart> {
  const { config } = await franchiseConfig();
  const rates = await oneTimeRates(config);
  const row = (c: CaseCode): ChartRow => {
    const r = oneTimeSplit(c, 10_000, rates);
    return {
      caseCode: c,
      who: WHO[c],
      directBp: r.directBp,
      leadBp: r.leadBp,
      topBp: r.topBp,
      amounts: CHART_EXAMPLE_FEES.map((f) => {
        const s = oneTimeSplit(c, f.feePaise, rates);
        return { key: f.key, direct: s.direct, lead: s.lead, top: s.top, total: s.direct + s.lead + s.top };
      }),
    };
  };
  return {
    rates,
    examples: CHART_EXAMPLE_FEES,
    modelA: (["A1", "A2", "A3", "A4"] as const).map(row),
    modelB: (["B1", "B2", "B3", "B4"] as const).map(row),
    recurring: {
      gokesariCommissionBp: config.gokesariCommissionBp,
      recurringBaseBp: config.recurringBaseBp,
      bonusMaxBp: config.bonusMaxBp,
      monthlyShopTarget: config.monthlyShopTarget,
      expectedBusinessPerShopPaise: config.expectedBusinessPerShopPaise,
      businessSlotPaise: config.businessSlotPaise,
      basePointsPerMainPoint: config.basePointsPerMainPoint,
      bonusBpPerMainPoint: config.bonusBpPerMainPoint,
      tailYears: config.tailYears,
      validityMonths: config.validityMonths,
      maxOwnersPerZone: config.maxOwnersPerZone,
    },
  };
}
