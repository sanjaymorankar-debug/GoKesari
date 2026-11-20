/** GET — one listing of a verified store, with its rental terms and damage policy (public). */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireHealthEnabled } from "@/server/health/access";
import { uuidParam } from "@/server/health/http";
import { listingDetail } from "@/server/health/rentals";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  enforceRateLimit(clientKey(request, "health-equipment-listing"), RATE_LIMITS.SEARCH_SUGGEST);
  await requireHealthEnabled();
  return ok(await listingDetail(await uuidParam(context, "id")));
});
