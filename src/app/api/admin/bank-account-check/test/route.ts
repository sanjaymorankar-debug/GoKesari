/**
 * Finance: test the Verification Suite connection with Cashfree's own sandbox
 * sample account (sandbox keys only). Returns what Cashfree answered and this
 * server's outbound IP (to whitelist in Cashfree). FINANCE_MANAGE.
 */
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { testBankCheckConnection } from "@/server/services/bank-account-check";

export const dynamic = "force-dynamic";

export const POST = route(async () => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  enforceRateLimit(`bank-account-check-test:${user.id}`, RATE_LIMITS.PAYMENT);
  return ok(await testBankCheckConnection(user));
});
