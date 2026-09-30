/**
 * Notification delivery sweep. Schedule every minute:
 *   curl -X POST https://<host>/api/cron/notifications -H "Authorization: Bearer $CRON_SECRET"
 *
 * Sends queued outbound notifications (email today) and retries failed ones on
 * the configured backoff. Safe to overlap — rows are claimed with SKIP LOCKED.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { deliverPending } from "@/server/services/notifications";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await deliverPending();
  console.info("[cron:notifications]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without sending anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
