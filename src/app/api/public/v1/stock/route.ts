/** Public API (billing v2): GET stock (stock:read); PATCH items' HSN / GST / price (stock:write). */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { authenticateApi } from "@/server/public-api/auth";
import { apiImport, apiStock } from "@/server/public-api/handlers";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const caller = await authenticateApi(request, "stock:read");
  enforceRateLimit(`public:${caller.clientId}`, { limit: 600, windowMs: 60_000 });
  return ok(await apiStock(caller.shopId));
});

export const PATCH = route(async (request: NextRequest) => {
  const caller = await authenticateApi(request, "stock:write");
  enforceRateLimit(`public:${caller.clientId}`, { limit: 600, windowMs: 60_000 });
  const body = (await request.json()) as { stockItems?: unknown[] };
  return ok(await apiImport(caller.shopId, { stockItems: body.stockItems ?? [] }));
});
