/**
 * Shop acceptance timeout sweep (NEW-007, rule shopAcceptance). Schedule every minute:
 *   curl -X POST https://<host>/api/cron/shop-acceptance \
 *        -H "Authorization: Bearer $CRON_SECRET"
 *
 * Reminds shops of orders waiting to be accepted, and cancels (full refund)
 * orders not accepted by their accept-by time. Idempotent; does nothing while
 * the rule is off.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runShopAcceptanceSweep } from "@/server/services/shop-acceptance";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await runShopAcceptanceSweep();
  console.info("[cron:shop-acceptance]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without acting. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
