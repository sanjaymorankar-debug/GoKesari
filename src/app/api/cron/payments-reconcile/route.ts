/**
 * Payment reconciliation (batch-2026-10 WS-A, F1.8.4). Schedule every 5 minutes:
 *   curl -X POST https://<host>/api/cron/payments-reconcile -H "Authorization: Bearer $CRON_SECRET"
 *
 * Online payment attempts still open `onlinePayments.reconcileAfterMinutes`
 * after they started (or past their expiry) are checked with the gateway and
 * moved to CAPTURED / FAILED / EXPIRED; queued refunds are sent and pending
 * ones polled; online orders whose payment never opened are released.
 * Idempotent; overlapping runs are safe (row locks + the state machine).
 */
import type { NextRequest } from "next/server";

import { assertCronAuthorized } from "@/server/api/cron-auth";
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runPaymentReconciliation } from "@/server/payments/processing";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await runPaymentReconciliation();
  console.info("[cron:payments-reconcile]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without acting. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
