/**
 * Fraud / risk rules sweep (GS-068). Schedule hourly:
 *   curl -X POST https://<host>/api/cron/risk-rules -H "Authorization: Bearer $CRON_SECRET"
 * Raises or refreshes OPEN flags for operations to review. Safe to re-run.
 * Event layer: this hourly run is the scan for patterns across orders; the
 * per-order rules also run at placement and on a failed payment (risk.ts).
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runRiskRules } from "@/server/services/risk";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await runRiskRules({ id: null, role: null });
  console.info("[cron:risk-rules]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without running the rules. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
