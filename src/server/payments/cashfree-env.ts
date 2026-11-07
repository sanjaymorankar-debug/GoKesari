/**
 * Cashfree set-up checks shared by every place that starts a Cashfree payment
 * (docs/payments-cashfree-audit-2026-11): the wallet and shop-wallet top-ups,
 * the shop registration fee, the ₹1 bank-account check and the order gateway.
 *
 *  - assertCashfreeEnvSafe: refuses to start a payment when the sandbox is
 *    set up on gokesari.com (pretend money would buy real goods) or
 *    production on test.gokesari.com (real money on the test site).
 *  - cashfreeNotifyUrl: the webhook URL sent with an order, only over https
 *    (Cashfree refuses plain http, and local development has no public URL).
 *  - cashfreeOrderExpiry: an order_expiry_time, so an abandoned checkout
 *    stops being payable and the reconciliation job can close it.
 */
import { cashfreeEnvProblem } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { paymentBaseUrl } from "./gateway/common";

export const CASHFREE_MISCONFIGURED_MESSAGE =
  "Online payment is switched off on this site until its payment settings are corrected. Please try again later or pay another way.";

/** Throws (409) when Cashfree is set up for the wrong environment on this site. */
export function assertCashfreeEnvSafe(product: "pg" | "payouts" | "verification" = "pg"): void {
  const problem = cashfreeEnvProblem(product);
  if (!problem) return;
  // The reason is for the operator (server log, admin health check), not the customer.
  console.error(`[cashfree] refused to start a ${product} call: ${problem}`);
  throw new AppError("CONFLICT", CASHFREE_MISCONFIGURED_MESSAGE, { reason: "CASHFREE_ENV_MISMATCH" });
}

/** `https://<site>/<path>` for order_meta.notify_url, or undefined when the site is not on https. */
export function cashfreeNotifyUrl(path: string): string | undefined {
  const base = paymentBaseUrl();
  return base.startsWith("https://") ? `${base}${path.startsWith("/") ? path : `/${path}`}` : undefined;
}

/** order_expiry_time `minutes` from now (Cashfree needs at least 15 minutes). */
export function cashfreeOrderExpiry(minutes: number, now: Date = new Date()): string {
  return new Date(now.getTime() + Math.max(16, minutes) * 60_000).toISOString();
}
