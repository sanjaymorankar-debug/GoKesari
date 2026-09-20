/** GET /api/product-master/products/{id}/price-history - append-only observations plus lowest / highest / average. */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { assertMasterId } from "@/server/pmd/api";
import { appSql } from "@/server/pmd/db";
import { priceHistoryQuerySchema } from "@/server/pmd/schemas";
import { getPriceHistory, getProduct } from "@/server/pmd/services/products";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const id = assertMasterId((await context.params).id);
  const q = parseQuery(request, priceHistoryQuerySchema);
  const sql = appSql();
  if (!(await getProduct(sql, id))) throw notFound("Product");
  return ok({ masterProductId: id, ...(await getPriceHistory(sql, id, q)) });
});
