/** GET /api/product-master/products/{master_product_id} - the full record with provenance. */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { assertMasterId } from "@/server/pmd/api";
import { appSql } from "@/server/pmd/db";
import { getProduct } from "@/server/pmd/services/products";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const { id } = await context.params;
  const product = await getProduct(appSql(), assertMasterId(id));
  if (!product) throw notFound("Product");
  return ok(product);
});
