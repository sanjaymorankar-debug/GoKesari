/** What removing a category would affect — shown in the confirmation before DELETE. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getCategoryRemovalImpact } from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireAnyPermission([PERMISSIONS.PRODUCT_CATEGORY_MANAGE_ANY, PERMISSIONS.PRODUCT_CATEGORY_MANAGE_OWN]);
  const { id } = await context.params;
  z.string().uuid().parse(id);
  return ok(await getCategoryRemovalImpact(id));
});
