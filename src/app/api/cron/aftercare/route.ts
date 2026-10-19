/**
 * Aftercare job (batch-2026-10 WS-C). Schedule hourly:
 *   curl -X POST https://<host>/api/cron/aftercare -H "Authorization: Bearer $CRON_SECRET"
 *
 *  - Help desk SLA (F6.3.3): escalates live tickets that missed the
 *    acknowledgement (rule helpdesk.acknowledgeWithinHours, 48 h) or
 *    resolution deadline (helpdesk.resolveWithinDays, 30 days) and alerts
 *    administrators; closes resolved tickets nobody reopened.
 *  - Refunds to the original payment method (F6.2.3): retries gateway
 *    refunds that could not be sent and completes those the gateway has
 *    since confirmed.
 * Safe to re-run: every breach is stamped once and every refund step is
 * idempotent. Hourly is enough — the deadlines are hours and days.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { aftercare } from "@/server/cron/schedule";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await aftercare();
  console.info("[cron:aftercare]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without doing anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
