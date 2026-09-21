/**
 * POST /api/product-master/products/{id}/promote
 * Puts a master product into the live marketplace catalogue so shops can select it.
 * Audited in the same transaction. Marketplace prices never cross; see catalogue-bridge.ts.
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { assertMasterId, guarded } from "@/server/pmd/api";
import { appSql } from "@/server/pmd/db";
import { promoteBodySchema } from "@/server/pmd/schemas";
import { promoteToCatalogue } from "@/server/pmd/services/catalogue-bridge";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PMD_PROMOTE);
  const id = assertMasterId((await context.params).id);
  const body = await parseBody(request, promoteBodySchema);
  const result = await guarded(() => promoteToCatalogue(appSql(), id, { userId: user.id, role: user.role }, body));
  return ok(result, result.adopted ? 200 : 201);
});
