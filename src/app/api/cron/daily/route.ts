/**
 * Daily at 05:00 IST: subscription orders, document upkeep, GST reminders, the Saturday payout cycle and the Monday finance week.
 * Schedule: 30 23 * * * (UTC)
 *   curl -X POST https://<host>/api/cron/daily -H "Authorization: Bearer $CRON_SECRET"
 *
 * One of the three entry points of the whole cron schedule (owner, 19 Oct 2026).
 * Every job is idempotent and safe to overlap; one failing never stops the others.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runDaily } from "@/server/cron/schedule";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  return ok(await runDaily());
});

export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
