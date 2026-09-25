/** Full money trace of one order: payment, refunds, snapshot, adjustments, settlement, rider earning. FINANCE_VIEW. */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getOrderFinancialTrace } from "@/server/services/finance";

export const GET = route(async (_request: Request, context: RouteContext<{ orderNumber: string }>) => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  const { orderNumber } = await context.params;
  return ok(await getOrderFinancialTrace(decodeURIComponent(orderNumber)));
});
