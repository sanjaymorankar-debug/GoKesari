/**
 * Timeout sweep — the event layer's minute safety net (docs/event-driven-2026-10).
 * Schedule every minute:
 *   curl -X POST https://<host>/api/cron/timeout-sweep -H "Authorization: Bearer $CRON_SECRET"
 *
 * Everything here exists because time passed, not because someone acted —
 * every action (accept, reject, ready, rider accept/decline, pickup, drop) is
 * already handled in its own request. In one run:
 *   1. shop acceptance: reminder, then at X minutes (rule shopAcceptance)
 *      cancel with a full refund or escalate to support;
 *   2. rider offers nobody answered in time move to the next rider, READY
 *      orders still without a rider are retried on the dispatch pace, and
 *      orders booked for a later slot look for a rider shortly before it;
 *   3. no rider accepted within Y minutes (rule dispatch.alertSupportAfterMinutes):
 *      support is alerted, once;
 *   4. return pickups: the same offer / retry loop;
 *   5. "the shop is open now" alerts for orders placed while it was closed;
 *   (batch-2026-10 WS-B) before 2: with rule dispatchBroadcast on, single
 *      offers nobody accepted go to every rider nearby, widening by step.
 * Each part runs even if another fails. Idempotent; overlapping runs are safe.
 * Replaces the shop-acceptance, delivery-dispatch and (with notification-retry)
 * notifications jobs, whose routes stay for rollback.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { timeoutSweep } from "@/server/cron/schedule";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await timeoutSweep();
  console.info("[cron:timeout-sweep]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without acting. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
