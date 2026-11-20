/**
 * GET — GoKesari Health home care: nearby verified providers (nurse, physiotherapist, attendant …) by
 * category, gender, language, rating, experience, price, home vs centre, PIN code; nearest first with lat/lng.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireHealthEnabled } from "@/server/health/access";
import { searchCareProviders } from "@/server/health/care";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "health-care-search"), RATE_LIMITS.SEARCH_SUGGEST);
  await requireHealthEnabled();
  return ok(await searchCareProviders(Object.fromEntries(request.nextUrl.searchParams.entries())));
});
