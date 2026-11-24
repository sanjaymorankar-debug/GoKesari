/**
 * Which payout providers may send money (23-Nov-2026).
 *
 * CASHFREE sends only once its contract has been checked against Cashfree
 * (the sandbox contract workflow, then the ₹1 live test) and
 * CASHFREE_PAYOUTS_CONTRACT_VERIFIED=true is set on that site. Until then the
 * rules payouts, riderPayouts and dealerAutoPayout cannot be saved with
 * provider CASHFREE, and no send path uses it even if a rule says so.
 * Webhooks and status lookups are not affected: transfers already with the
 * provider are still settled.
 */
import { getEnv } from "@/lib/env";
import { getPayoutProvider } from "./providers";
import type { PayoutProvider } from "./types";

export const PAYOUT_PROVIDER_RULES = ["payouts", "riderPayouts", "dealerAutoPayout"] as const;

export function cashfreePayoutsContractVerified(): boolean {
  return getEnv().CASHFREE_PAYOUTS_CONTRACT_VERIFIED === "true";
}

/** Null when `provider` may be chosen in a payout rule, else why not. */
export function payoutProviderRuleProblem(provider: string): string | null {
  if (provider.toUpperCase() === "CASHFREE" && !cashfreePayoutsContractVerified()) {
    return "Cashfree Payouts cannot be chosen yet: its contract tests must pass and CASHFREE_PAYOUTS_CONTRACT_VERIFIED=true be set on this site first.";
  }
  return null;
}

/** The provider a send path may use: known, configured, and allowed to send. Null otherwise. */
export function sendingPayoutProvider(name: string): PayoutProvider | null {
  const provider = getPayoutProvider(name);
  if (!provider || !provider.isConfigured()) return null;
  if (payoutProviderRuleProblem(provider.name)) return null;
  return provider;
}
