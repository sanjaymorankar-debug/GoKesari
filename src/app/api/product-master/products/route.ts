/** GET /api/product-master/products - the product master, filtered and keyset-paginated. */
import type { NextRequest } from "next/server";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { listQuerySchema } from "@/server/pmd/schemas";
import { listProducts } from "@/server/pmd/services/products";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const q = parseQuery(request, listQuerySchema);
  return ok(await listProducts(appSql(), q, { limit: q.limit, cursor: q.cursor }));
});
