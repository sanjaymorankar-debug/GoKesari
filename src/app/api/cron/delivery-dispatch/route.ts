/**
 * Delivery dispatch sweep (GA-006 / GA-009). Schedule every minute:
 *   curl -X POST https://<host>/api/cron/delivery-dispatch \
 *        -H "Authorization: Bearer $CRON_SECRET"
 *
 * Expires rider offers not answered within OFFER_TTL_SECONDS (the rider is
 * then never re-offered that order), and re-tries a rider for every READY
 * order of a delivering shop that has nobody working on it. Idempotent —
 * overlapping runs are safe (assignment locks the partner row).
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runDispatchSweep } from "@/server/services/delivery-assignment";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await runDispatchSweep();
  console.info("[cron:delivery-dispatch]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without dispatching anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
