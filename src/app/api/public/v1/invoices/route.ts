/** Public API (billing v2): the shop's invoices (invoices:read). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { authenticateApi } from "@/server/public-api/auth";
import { apiInvoices } from "@/server/public-api/handlers";

export const dynamic = "force-dynamic";
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GET = route(async (request: NextRequest) => {
  const caller = await authenticateApi(request, "invoices:read");
  enforceRateLimit(`public:${caller.clientId}`, { limit: 600, windowMs: 60_000 });
  const p = request.nextUrl.searchParams;
  return ok(await apiInvoices(caller.shopId, date.parse(p.get("from")), date.parse(p.get("to"))));
});
