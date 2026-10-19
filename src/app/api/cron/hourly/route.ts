/**
 * Hourly: risk patterns, dispute and help-desk deadlines, refund and payout retries, expired sign-in codes.
 * Schedule: 17 * * * *
 *   curl -X POST https://<host>/api/cron/hourly -H "Authorization: Bearer $CRON_SECRET"
 *
 * One of the three entry points of the whole cron schedule (owner, 19 Oct 2026).
 * Every job is idempotent and safe to overlap; one failing never stops the others.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runHourly } from "@/server/cron/schedule";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  return ok(await runHourly());
});

export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
