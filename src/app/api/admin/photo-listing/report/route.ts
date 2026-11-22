/** Admin: products added by photo and AI accuracy (fields kept vs changed) over ?days (default 30). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { photoListingReport } from "@/server/services/shop-photo-listing";

export const dynamic = "force-dynamic";

const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.PRODUCT_APPROVE);
  const { days } = parseQuery(request, query);
  return ok(await photoListingReport(days));
});
