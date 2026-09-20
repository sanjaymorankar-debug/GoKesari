/**
 * GET /api/product-master/products/search?q=samsung+55+inch+4k+tv
 * Identifier (GTIN/EAN/UPC/ISBN/MPN/model/SKU), keyword and fuzzy search across brand, name, variant and model.
 */
import type { NextRequest } from "next/server";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { searchQuerySchema } from "@/server/pmd/schemas";
import { searchProducts } from "@/server/pmd/services/products";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const { q, limit, ...filters } = parseQuery(request, searchQuerySchema);
  return ok(await searchProducts(appSql(), q, filters, limit));
});
