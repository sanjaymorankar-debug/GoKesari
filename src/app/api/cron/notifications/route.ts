/**
 * Notification delivery sweep. Schedule every minute:
 *   curl -X POST https://<host>/api/cron/notifications -H "Authorization: Bearer $CRON_SECRET"
 *
 * Sends queued outbound notifications (email today) and retries failed ones on
 * the configured backoff. Also queues the one-time "shop is open now" alerts for
 * orders placed while a shop was closed. Safe to overlap — rows are claimed with SKIP LOCKED.
 *
 * Event layer: superseded by /api/cron/notification-retry (retries) and
 * /api/cron/timeout-sweep (shop-open alerts). Kept so the old crontab can be
 * restored (docs/event-driven-2026-10/ROLLBACK.md).
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { deliverPending } from "@/server/services/notifications";
import { sendShopOpeningAlerts } from "@/server/services/shop-opening";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  // Queue "shop is open, orders are waiting" alerts first so the delivery pass below sends them in the same run.
  const opening = await sendShopOpeningAlerts();
  const result = await deliverPending();
  console.info("[cron:notifications]", JSON.stringify({ ...result, opening }));
  return ok({ ...result, opening });
});

/** Health probe so a scheduler can verify wiring without sending anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
