/**
 * Remove the personal bank account (delivery partners, docs/gig-bank-payouts-2026-10).
 * Adding and changing it is PUT /api/bank-account (the same account customers use for refunds);
 * both need a fresh /api/gig/bank-account/reauth code when the account is verified.
 *   DELETE → 204-style { removed: true }
 */
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { removeBankAccount } from "@/server/rider-wallet/withdrawals";

export const dynamic = "force-dynamic";

export const DELETE = route(async () => {
  const user = await requireUser();
  enforceRateLimit(`bank-account:${user.id}`, RATE_LIMITS.PAYMENT);
  await removeBankAccount(user);
  return ok({ removed: true });
});
