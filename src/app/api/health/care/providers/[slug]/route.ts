/** GET — a home-care practice for patients: verified providers, badges, services and rates, reviews. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireHealthEnabled } from "@/server/health/access";
import { careProviderPage } from "@/server/health/care";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ slug: string }>) => {
  enforceRateLimit(clientKey(request, "health-care-provider"), RATE_LIMITS.SEARCH_SUGGEST);
  await requireHealthEnabled();
  return ok(await careProviderPage(z.string().min(1).max(200).parse((await context.params).slug)));
});
