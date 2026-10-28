/**
 * The owner pays their shop's one-time registration fee online.
 *
 * POST → { intentId, amountPaise, redirectUrl }: where to send the browser to
 * pay what is still due (a live checkout for the same amount is reused). The
 * amount is always computed here from the shop's fee snapshot; the request
 * carries none. 409 when nothing is due. Money moves only through the gateway
 * and its capture handler (services/registration-fee-payment.ts).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startRegistrationFeeCheckout } from "@/server/services/registration-fee-payment";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(clientKey(request, `registration-fee:${user.id}`), RATE_LIMITS.PAYMENT);
  const id = z.string().uuid().parse((await context.params).id);
  return ok(await startRegistrationFeeCheckout(id, user), 201);
});
