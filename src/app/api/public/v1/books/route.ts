/** Public API (billing v2): GET the books (books:read); POST masters / vouchers (books:write). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { authenticateApi } from "@/server/public-api/auth";
import { apiBooks, apiImport } from "@/server/public-api/handlers";

export const dynamic = "force-dynamic";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(async (request: NextRequest) => {
  const caller = await authenticateApi(request, "books:read");
  enforceRateLimit(`public:${caller.clientId}`, { limit: 600, windowMs: 60_000 });
  const p = request.nextUrl.searchParams;
  return ok(await apiBooks(caller.shopId, date.parse(p.get("from")), date.parse(p.get("to"))));
});

export const POST = route(async (request: NextRequest) => {
  const caller = await authenticateApi(request, "books:write");
  enforceRateLimit(`public:${caller.clientId}`, { limit: 600, windowMs: 60_000 });
  const body = (await request.json()) as Record<string, unknown>;
  return ok(await apiImport(caller.shopId, body));
});
