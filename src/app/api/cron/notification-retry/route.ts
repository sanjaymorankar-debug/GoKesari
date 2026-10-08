/**
 * Notification retry — the event layer's outbox safety net. Schedule every minute:
 *   curl -X POST https://<host>/api/cron/notification-retry -H "Authorization: Bearer $CRON_SECRET"
 *
 * Every notification is sent by the event that causes it, the moment it
 * happens. This only retries what failed: notification_deliveries rows left
 * FAILED (or stuck SENDING) are sent again on the backoff in rule
 * `notifications`, up to `maxAttempts` (N); then the row is marked DEAD and
 * support is alerted in the app. Safe to overlap — rows are claimed with SKIP LOCKED.
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
  console.info("[cron:notification-retry]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without sending anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
