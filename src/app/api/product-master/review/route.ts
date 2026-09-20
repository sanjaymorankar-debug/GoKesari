/** GET /api/product-master/review - the possible-duplicate queue: pairs the matcher would not merge on its own. */
import type { NextRequest } from "next/server";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { appSql } from "@/server/pmd/db";
import { pageQuerySchema } from "@/server/pmd/schemas";
import { listReviewQueue } from "@/server/pmd/services/reference";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PMD_VIEW);
  const q = parseQuery(request, pageQuerySchema);
  return ok(await listReviewQueue(appSql(), { limit: q.limit, cursor: q.cursor }));
});
