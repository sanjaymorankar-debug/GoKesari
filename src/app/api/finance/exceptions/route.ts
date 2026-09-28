/**
 * Financial exception queue (Part K/O). Operators (FINANCE_EXCEPTIONS_VIEW)
 * get the operational view; admins (FINANCE_VIEW) also see failed/reversed
 * settlements & payouts and orders missing a settlement.
 */
import { ok, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listFinancialExceptions } from "@/server/services/finance";

export const GET = route(async () => {
  const user = await requireAnyPermission([PERMISSIONS.FINANCE_VIEW, PERMISSIONS.FINANCE_EXCEPTIONS_VIEW]);
  return ok(await listFinancialExceptions(can(user.role, PERMISSIONS.FINANCE_VIEW) ? "admin" : "operator"));
});
