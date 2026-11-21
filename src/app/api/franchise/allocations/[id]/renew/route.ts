/** POST { couponCode? } — renew one franchise at the zone's current fee (open 30 days before expiry until 23:59:59 IST on the expiry day). Never auto-charged. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startRenewal } from "@/server/franchise/booking";
import { checkoutUrlOf } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-renew:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, z.object({ couponCode: z.string().trim().max(30).nullish() }).default({}));
  const created = await startRenewal((await params).id, user, { couponCode: body.couponCode ?? null });
  return ok({ intentId: created.intent.id, checkoutUrl: checkoutUrlOf(created as never) });
});
