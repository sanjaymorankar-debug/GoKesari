/**
 * Weekly finance batch (GS-062/064/031). Schedule once a week (e.g. Monday 06:00 IST):
 *   curl -X POST https://<host>/api/cron/finance-weekly -H "Authorization: Bearer $CRON_SECRET"
 * Prepares PENDING shop settlements and rider payouts for the previous week
 * and re-runs reconciliation over the last 35 days. Approval and payment stay
 * with an admin. Safe to re-run.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { financeWeekly } from "@/server/cron/schedule";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await financeWeekly();
  console.info("[cron:finance-weekly]", JSON.stringify(result));
  return ok(result);
});
