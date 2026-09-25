/**
 * Weekly finance batch (GS-062/064/031). Schedule once a week (e.g. Monday 06:00 IST):
 *   curl -X POST https://<host>/api/cron/finance-weekly -H "Authorization: Bearer $CRON_SECRET"
 * Prepares PENDING shop settlements and rider payouts for the previous week
 * and re-runs reconciliation over the last 35 days. Approval and payment stay
 * with an admin. Safe to re-run.
 */
import type { NextRequest } from "next/server";

import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import {
  prepareRiderPayouts,
  prepareShopSettlements,
  previousWeekStart,
  runReconciliation,
} from "@/server/services/finance";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const weekStart = previousWeekStart();
  const system = { id: null, role: null };
  const settlements = await prepareShopSettlements(weekStart, system);
  const payouts = await prepareRiderPayouts(weekStart, system);
  const today = todayIn(getEnv().APP_TIMEZONE);
  const reconciliation = await runReconciliation(addDays(today, -35), addDays(today, 1), system);
  const result = { weekStart, settlements: settlements.length, payouts: payouts.length, reconciliation };
  console.info("[cron:finance-weekly]", JSON.stringify(result));
  return ok(result);
});
