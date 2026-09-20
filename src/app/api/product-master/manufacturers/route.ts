/** GET /api/product-master/manufacturers?q=... */
import type { NextRequest } from "next/server";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { pageQuerySchema } from "@/server/pmd/schemas";
import { listManufacturers } from "@/server/pmd/services/reference";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  return ok(await listManufacturers(appSql(), parseQuery(request, pageQuerySchema)));
});
