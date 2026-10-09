/**
 * Accounting-integration safety net (Module 2). Schedule every minute:
 *   curl -X POST https://<host>/api/cron/integration-sync -H "Authorization: Bearer $CRON_SECRET"
 *
 * Every invoice and credit note is queued by the event that causes it and
 * sent straight after commit (Tally: picked up by the connector's long-poll).
 * This only runs retries that came due, re-queues a push whose hook failed,
 * warns owners whose Tally connector is offline with entries waiting, and
 * retries e-invoices that failed while the GSP was down. Safe to overlap.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { integrationSweep } from "@/server/integrations/sweep";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await integrationSweep();
  console.info("[cron:integration-sync]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without running anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
