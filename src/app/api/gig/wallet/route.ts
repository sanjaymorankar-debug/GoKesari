/**
 * The signed-in delivery partner's wallet (docs/gig-bank-payouts-2026-10):
 * unpaid earnings, the bank account (masked), withdrawal limits, payments.
 *   GET → RiderWalletView. 404 while the rider bank account flag is off.
 */
import { ok, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getRiderWallet } from "@/server/rider-wallet/views";
import { requireFeature } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  await requireFeature("rider_bank_account_enabled");
  return ok(await getRiderWallet(user.id));
});
