/** RBAC v2 Phase 3: the proposer withdraws a rate proposal that is still waiting. */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { cancelRateProposal } from "@/server/rbac-accounting/rates";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.RATE_PROPOSE);
  const { id } = await context.params;
  return ok(await cancelRateProposal(id, actor));
});
