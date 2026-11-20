/** GET ?q=&category=&lat=&lng=&radiusKm=&rent=1 — listings of nearby verified medical equipment stores (nearest first). */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireHealthEnabled } from "@/server/health/access";
import { browseEquipment } from "@/server/health/rentals";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "health-equipment-search"), RATE_LIMITS.SEARCH_SUGGEST);
  await requireHealthEnabled();
  return ok(await browseEquipment(Object.fromEntries(request.nextUrl.searchParams.entries())));
});
