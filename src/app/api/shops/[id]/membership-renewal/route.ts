/**
 * The owner renews their shop's yearly membership online (docs/shop-membership-renewal-2026-11).
 *
 * POST → { intentId, amountPaise, redirectUrl }: where to send the browser to pay the renewal fee for
 * the current period (a live checkout for the same period and amount is reused). The amount is computed
 * here (rule shopMembership); the request carries none. 409 while rule renewalCheckoutEnabled is off,
 * before the renewal window, for an exempt shop, or while the registration fee is still owed. Only the
 * shop's own owner (another owner's shop is a 404). Money moves only through the gateway and its
 * capture handler (services/shop-membership-renewal.ts).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startMembershipRenewalCheckout } from "@/server/services/shop-membership-renewal";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(clientKey(request, `membership-renewal:${user.id}`), RATE_LIMITS.PAYMENT);
  const id = z.string().uuid().parse((await context.params).id);
  return ok(await startMembershipRenewalCheckout(id, user), 201);
});
