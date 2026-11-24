/**
 * docs/tax-register/PAYOUT_DEDUCTIONS.md: shared switches for the deductions withheld on every
 * payout path (flag payout_deductions). The maths is the shared TDS calculator
 * (rider-wallet/rules.ts computeTds) and the payout cycle's TCS / TDS.
 */
import { conflict } from "@/lib/errors";
import { isProductionSite } from "@/lib/env";
import { isFeatureEnabled } from "@/server/services/feature-flags";

/** Prefixes of the shop adjustments that are service earnings (appointments, rentals, prescriptions). */
export const SERVICE_EARNING_PREFIXES = ["consult:", "healthrent:", "healthrx:"] as const;

export function isServiceEarning(a: { type: string; idempotencyKey: string | null; amountPaise: number; reason?: string | null }): boolean {
  if (a.type !== "SHOP_ADJUSTMENT" || a.amountPaise <= 0 || !a.idempotencyKey) return false;
  if (/commission/i.test(a.reason ?? "")) return false;
  return SERVICE_EARNING_PREFIXES.some((p) => a.idempotencyKey!.startsWith(p));
}

export async function payoutDeductionsOn(): Promise<boolean> {
  return isFeatureEnabled("payout_deductions");
}

/**
 * On gokesari.com a payment whose deduction rate the CA has not approved is held (the caller
 * refuses to prepare it); on test.gokesari.com and local builds it goes ahead.
 */
export function holdUnlessApproved(approved: boolean, what: string, production: boolean = isProductionSite()): void {
  if (production && !approved) throw conflict(`${what}: the CA has not approved the rate yet (Tax register). The payment is held until it is approved.`);
}
