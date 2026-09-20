/** GET /api/product-master/products/{id}/offers - every seller's current offer. `?current=true` hides delisted ones. */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { assertMasterId } from "@/server/pmd/api";
import { appSql } from "@/server/pmd/db";
import { getOffers, getProduct } from "@/server/pmd/services/products";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const id = assertMasterId((await context.params).id);
  const sql = appSql();
  if (!(await getProduct(sql, id))) throw notFound("Product");
  const currentOnly = new URL(request.url).searchParams.get("current") === "true";
  const offers = await getOffers(sql, id, { currentOnly });
  return ok({ masterProductId: id, count: offers.length, offers });
});
