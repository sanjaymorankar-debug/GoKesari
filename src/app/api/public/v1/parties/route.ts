/** Public API (billing v2): customers and suppliers (parties:read). */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { authenticateApi } from "@/server/public-api/auth";
import { apiParties } from "@/server/public-api/handlers";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const caller = await authenticateApi(request, "parties:read");
  enforceRateLimit(`public:${caller.clientId}`, { limit: 600, windowMs: 60_000 });
  return ok(await apiParties(caller.shopId));
});
