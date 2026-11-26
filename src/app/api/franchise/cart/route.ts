/** POST { zoneIds, couponCode?, planId? (onboarding v2) } — the cart before reserving (§5.5, §5.7): each zone's fee, tier, coupon discount, GST, total. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { previewCart } from "@/server/franchise/booking";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-cart:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ zoneIds: z.array(z.string().trim().min(1).max(16)).min(1).max(50), couponCode: z.string().trim().max(30).nullish(), planId: z.string().uuid().nullish() }));
  return ok(await previewCart(user, body));
});
