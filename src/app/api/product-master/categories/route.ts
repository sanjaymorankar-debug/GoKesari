/** GET /api/product-master/categories[?level=2][&parent=dairy] - the standard taxonomy with live product counts. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { listCategories } from "@/server/pmd/services/reference";

export const dynamic = "force-dynamic";

const schema = z.object({
  level: z.coerce.number().int().min(1).max(5).optional(),
  parent: z.string().max(200).optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const categories = await listCategories(appSql(), parseQuery(request, schema));
  return ok({ count: categories.length, categories });
});
