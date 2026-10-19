/**
 * Payout cycle (batch-2026-10 WS-E, F10.2.4). Periodic by nature — schedule
 * daily (e.g. 06:10 IST); it acts only when a cycle (rule payouts.cycleDays,
 * default 7 days from Saturday payouts.anchorDate, so every Saturday) has ended:
 *   curl -X POST https://<host>/api/cron/payout-cycle -H "Authorization: Bearer $CRON_SECRET"
 * Closes the cycle and drafts its payout batch (approval stays with an
 * administrator), retries failed transfers whose backoff has passed, and
 * sends queued document emails. Does nothing while rule payouts is off.
 * Safe to re-run: a closed cycle is never closed twice.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { payoutCycle } from "@/server/cron/schedule";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await payoutCycle();
  console.info("[cron:payout-cycle]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without doing anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
