/** RBAC v2 Phase 4: the shop's price-list template (CSV, pre-filled with today's values). */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { buildBulkTemplate } from "@/server/rbac-support/bulk";
import { requireFeatureForRole } from "@/server/services/feature-flags";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.SHOP_CHANGE_PROPOSE);
  await requireFeatureForRole("rbac_v2_shop_change_requests", actor.role);
  const { id } = await context.params;
  return new NextResponse(await buildBulkTemplate(id), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="price-list-${id}.csv"`, "cache-control": "no-store" },
  });
});
