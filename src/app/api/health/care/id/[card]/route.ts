/** GET — the public check behind a home-care ID card's QR: name, photo and verified status only. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { publicIdCard } from "@/server/health/care";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ card: string }>) => {
  enforceRateLimit(clientKey(request, "health-care-id"), RATE_LIMITS.SEARCH_SUGGEST);
  const card = await publicIdCard(z.string().max(40).parse((await context.params).card));
  if (!card) throw notFound("ID card");
  return ok(card);
});
