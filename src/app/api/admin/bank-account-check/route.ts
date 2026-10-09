/**
 * Finance: is the bank check (Cashfree Verification Suite, O-7) set up on this site?
 * Rule on/off, which key names were found (never their values), the 2FA mode,
 * and the last few checks with Cashfree's answers. FINANCE_VIEW.
 */
import { ok, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { bankCheckAdminStatus } from "@/server/services/bank-account-check";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await bankCheckAdminStatus(user));
});
