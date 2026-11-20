/**
 * GET — Find a Consultant (docs/consult-booking-2026-11): public search by category, service / name (q),
 * language, mode, fee range (rupees) and a day with free time; nearest first when lat/lng are given.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireConsultEnabled } from "@/server/consult/access";
import { searchConsultants } from "@/server/consult/discovery";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "consult-search"), RATE_LIMITS.SEARCH_SUGGEST);
  await requireConsultEnabled();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  return ok(await searchConsultants(params));
});
