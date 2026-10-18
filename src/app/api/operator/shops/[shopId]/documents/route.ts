/** GET — an own shop's documents by shop type (FSSAI, licences…), with their status (F8.4.2). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getShopDocumentsForOperator } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_VERIFY_DOCS);
  const shopId = z.string().uuid().parse((await context.params).shopId);
  return ok(await getShopDocumentsForOperator(shopId, user));
});
