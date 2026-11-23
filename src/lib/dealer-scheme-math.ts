/**
 * Dealership & Franchise Platform (docs/dealer-platform/): the scheme calculator's arithmetic, with no database —
 * used by the live calculator (src/server/dealers/scheme-calculator.ts) and by the admin's simulator in the
 * browser, so both always agree. Amounts in paise, rates in basis points. Formula components run in the safe
 * formula engine (src/lib/dealer-formula.ts; no eval).
 */
import { compileFormula, DEALER_FORMULA_VARIABLE_NAMES } from "@/lib/dealer-formula";
import { chargeTotals, type SchemeComponent, type SchemeTerms } from "@/lib/dealer-schemes";

export const BUDGET_NOTE = "scaled down to the scheme's commission budget";

/** Values a component can be computed from (paise), and the formula variables. */
export interface BasisValues {
  shopRegistrationFeePaise: number;
  shopActivationFeePaise: number;
  platformCommissionPaise: number;
  transactionValuePaise: number;
  netTransactionValuePaise: number;
  shopsThisMonth: number;
  activeShops: number;
  monthsSinceActivation: number;
  dealerRating: number;
}

export const ZERO_BASIS: BasisValues = {
  shopRegistrationFeePaise: 0,
  shopActivationFeePaise: 0,
  platformCommissionPaise: 0,
  transactionValuePaise: 0,
  netTransactionValuePaise: 0,
  shopsThisMonth: 0,
  activeShops: 0,
  monthsSinceActivation: 0,
  dealerRating: 5,
};

function basisAmount(c: SchemeComponent, v: BasisValues): number {
  switch (c.basis) {
    case "SHOP_REGISTRATION_FEE":
      return v.shopRegistrationFeePaise;
    case "SHOP_ACTIVATION_FEE":
      return v.shopActivationFeePaise;
    case "PLATFORM_COMMISSION":
      return v.platformCommissionPaise;
    case "TRANSACTION_VALUE":
      return v.transactionValuePaise;
    case "NET_TRANSACTION_VALUE":
      return v.netTransactionValuePaise;
    default:
      return 0;
  }
}

/** One component's amount in whole paise (never negative). Formula components run in the safe formula engine. */
export function componentAmount(c: SchemeComponent, v: BasisValues, extra: Record<string, number> = {}): number {
  if (c.basis === "LEGACY") return 0;
  if (c.basis === "FIXED_PER_SHOP") return Math.max(0, Math.round(c.fixedPaise ?? 0));
  if (c.basis === "FORMULA") {
    // Custom fields (phase 5) come in as cf_<key> variables next to the dealer variables.
    const compiled = compileFormula(c.formula ?? "", [...DEALER_FORMULA_VARIABLE_NAMES, ...Object.keys(extra)]);
    if (!compiled.ok) throw new Error(`Component ${c.id}: ${compiled.error}`);
    return Math.max(0, Math.round(compiled.evaluate({ ...v, ...extra })));
  }
  return Math.max(0, Math.round((basisAmount(c, v) * (c.rateBp ?? 0)) / 10_000));
}

export type Payee = "SIGNER" | "LEVEL_1" | "LEVEL_2" | "MAIN";

export interface OneTimeLine {
  componentId: string;
  label: string;
  entryType: "SCHEME_ONE_TIME" | "SCHEME_TEAM";
  payee: Payee;
  amountPaise: number;
  rateBp: number | null;
  scaled: boolean;
}

/**
 * The one-time lines for one shop. `signedByMember`: a team member signed it; `levelsAbove`: how many people are
 * above the signer (0 = the dealer signed; 1 = a lead or an agent with no lead, the dealer above; 2 = an agent
 * under a lead). Applies the commission budget.
 */
export function oneTimeLines(terms: SchemeTerms, v: BasisValues, team: { signedByMember: boolean; levelsAbove: 0 | 1 | 2 }, extra: Record<string, number> = {}): OneTimeLine[] {
  const lines: OneTimeLine[] = [];
  for (const c of terms.components) {
    if (c.frequency !== "ONCE") continue;
    if (c.kind === "ONE_TIME") {
      lines.push({ componentId: c.id, label: c.label, entryType: "SCHEME_ONE_TIME", payee: terms.teamBuilding && team.signedByMember ? "SIGNER" : "MAIN", amountPaise: componentAmount(c, v, extra), rateBp: c.rateBp ?? null, scaled: false });
    } else if (c.kind === "TEAM_OVERRIDE" && terms.teamBuilding && team.signedByMember && c.level && c.level <= team.levelsAbove) {
      lines.push({ componentId: c.id, label: c.label, entryType: "SCHEME_TEAM", payee: c.level === 1 ? "LEVEL_1" : "LEVEL_2", amountPaise: componentAmount(c, v, extra), rateBp: c.rateBp ?? null, scaled: false });
    }
  }
  const total = lines.reduce((n, l) => n + l.amountPaise, 0);
  if (terms.commissionBudgetBp !== null && total > 0) {
    const budget = Math.floor((v.shopRegistrationFeePaise * terms.commissionBudgetBp) / 10_000);
    if (total > budget) {
      let left = budget;
      lines.forEach((l, i) => {
        const share = i === lines.length - 1 ? left : Math.floor((l.amountPaise * budget) / total);
        l.amountPaise = Math.max(0, Math.min(share, left));
        left -= l.amountPaise;
        l.scaled = true;
      });
    }
  }
  return lines.filter((l) => l.amountPaise > 0);
}

/** A monthly component's amount for one shop in one month (0 outside its duration). */
export function recurringAmount(c: SchemeComponent, v: BasisValues, extra: Record<string, number> = {}): number {
  if (c.frequency === "ONCE") return 0;
  if (c.durationMonths && v.monthsSinceActivation >= c.durationMonths) return 0;
  return componentAmount(c, v, extra);
}

/** Whole months between the activation month and `month` (YYYY-MM), in IST. */
export function monthsBetween(activatedAt: Date, month: string): number {
  const a = istMonthOf(activatedAt);
  const [ay, am] = a.split("-").map(Number);
  const [y, m] = month.split("-").map(Number);
  return (y - ay) * 12 + (m - am);
}

function istMonthOf(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 7);
}

/* ================================================================ simulator */

export interface SimulationInput {
  /** Dealers joining on this scheme. */
  dealers: number;
  /** Shops each dealer registers in a month. */
  shopsPerDealerPerMonth: number;
  /** Share of registered shops that activate (basis points, 10000 = all). */
  activationBp: number;
  /** Average shop registration fee before GST (paise). */
  avgRegistrationFeePaise: number;
  /** Average completed sales per active shop per month (paise). */
  monthlySalesPerShopPaise: number;
  /** GoKesari's commission on sales (basis points). */
  platformCommissionBp: number;
  /** How many months to project (1–36). */
  months: number;
}

export interface SimulationMonth {
  month: number;
  activeShops: number;
  gmvPaise: number;
  platformRevenuePaise: number;
  dealerPayoutPaise: number;
  netRevenuePaise: number;
}

export interface SimulationResult {
  months: SimulationMonth[];
  totals: {
    joiningFeesPaise: number;
    registrationFeesPaise: number;
    gmvPaise: number;
    platformCommissionPaise: number;
    platformRevenuePaise: number;
    oneTimePayoutPaise: number;
    recurringPayoutPaise: number;
    dealerPayoutPaise: number;
    netRevenuePaise: number;
  };
  /** Of the total: the first 12 months (annual view). */
  firstYear: { platformRevenuePaise: number; dealerPayoutPaise: number; netRevenuePaise: number };
}

/**
 * What a scheme costs and earns: the dealers' joining charges (before GST), the shops' registration fees, the sales
 * (GMV) and GoKesari's commission on them; the dealer payout (one-time + monthly, by the same functions as the live
 * calculator, dealer-signed shops); GoKesari's net before other operating costs. GST is not revenue and is left out.
 */
export function simulateScheme(terms: SchemeTerms, input: SimulationInput): SimulationResult {
  const months = Math.max(1, Math.min(36, Math.floor(input.months)));
  const newShopsPerMonth = Math.max(0, input.dealers) * Math.max(0, input.shopsPerDealerPerMonth) * Math.max(0, Math.min(10_000, input.activationBp)) / 10_000;
  const joiningFeesPaise = Math.round(Math.max(0, input.dealers) * chargeTotals(terms.charge).basePaise);
  const cohorts: number[] = [];
  const out: SimulationMonth[] = [];
  const t = { joiningFeesPaise, registrationFeesPaise: 0, gmvPaise: 0, platformCommissionPaise: 0, platformRevenuePaise: 0, oneTimePayoutPaise: 0, recurringPayoutPaise: 0, dealerPayoutPaise: 0, netRevenuePaise: 0 };
  const perShopOneTime = oneTimeLines(terms, { ...ZERO_BASIS, shopRegistrationFeePaise: input.avgRegistrationFeePaise, shopActivationFeePaise: input.avgRegistrationFeePaise }, { signedByMember: false, levelsAbove: 0 }).reduce((n, l) => n + l.amountPaise, 0);
  const monthly = terms.components.filter((c) => c.frequency === "MONTHLY");
  for (let m = 0; m < months; m += 1) {
    cohorts.push(newShopsPerMonth);
    const activeShops = cohorts.reduce((n, c) => n + c, 0);
    const gmv = activeShops * input.monthlySalesPerShopPaise;
    const commission = (gmv * input.platformCommissionBp) / 10_000;
    const registrations = newShopsPerMonth * input.avgRegistrationFeePaise;
    const oneTime = newShopsPerMonth * perShopOneTime;
    let recurring = 0;
    cohorts.forEach((size, i) => {
      const shopCommission = (input.monthlySalesPerShopPaise * input.platformCommissionBp) / 10_000;
      const values: BasisValues = { ...ZERO_BASIS, platformCommissionPaise: shopCommission, transactionValuePaise: input.monthlySalesPerShopPaise, netTransactionValuePaise: input.monthlySalesPerShopPaise, monthsSinceActivation: m - i, activeShops, shopsThisMonth: newShopsPerMonth };
      for (const c of monthly) recurring += size * recurringAmount(c, values);
    });
    const validFor = terms.validityMonths ?? Infinity;
    if (m >= validFor) recurring = 0; // the scheme ran out (renewal not assumed)
    const revenue = commission + registrations + (m === 0 ? joiningFeesPaise : 0);
    const payout = oneTime + recurring;
    out.push({ month: m + 1, activeShops: Math.round(activeShops), gmvPaise: Math.round(gmv), platformRevenuePaise: Math.round(revenue), dealerPayoutPaise: Math.round(payout), netRevenuePaise: Math.round(revenue - payout) });
    t.registrationFeesPaise += registrations;
    t.gmvPaise += gmv;
    t.platformCommissionPaise += commission;
    t.oneTimePayoutPaise += oneTime;
    t.recurringPayoutPaise += recurring;
  }
  t.platformRevenuePaise = t.joiningFeesPaise + t.registrationFeesPaise + t.platformCommissionPaise;
  t.dealerPayoutPaise = t.oneTimePayoutPaise + t.recurringPayoutPaise;
  t.netRevenuePaise = t.platformRevenuePaise - t.dealerPayoutPaise;
  const round = (o: typeof t) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])) as typeof t;
  const year = out.slice(0, 12);
  return {
    months: out,
    totals: round(t),
    firstYear: {
      platformRevenuePaise: year.reduce((n, x) => n + x.platformRevenuePaise, 0),
      dealerPayoutPaise: year.reduce((n, x) => n + x.dealerPayoutPaise, 0),
      netRevenuePaise: year.reduce((n, x) => n + x.netRevenuePaise, 0),
    },
  };
}
