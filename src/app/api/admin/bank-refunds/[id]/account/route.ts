/** Finance: the full account details to send an open refund to bank. FINANCE_MANAGE; every look is audited. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { revealBankRefundAccount } from "@/server/services/bank-refunds";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  const { id } = await context.params;
  return ok(await revealBankRefundAccount(id, user));
});
