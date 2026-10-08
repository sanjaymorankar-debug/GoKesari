/**
 * Dispute escalation sweep (GS-058). Schedule hourly:
 *   curl -X POST https://<host>/api/cron/dispute-escalation -H "Authorization: Bearer $CRON_SECRET"
 *
 * The dispute SLA check (event layer safety net): escalates to an
 * administrator every live L1 case left without a reply from the shop or
 * support for `disputes.responseSlaHours` (SLA), or older than
 * `disputes.escalateAfterHours` (age). Safe to re-run: escalating moves a
 * case to L2, which the next sweep no longer selects. Hourly is enough — the
 * limits are measured in hours, not minutes.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { runDisputeEscalationSweep } from "@/server/services/disputes";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await runDisputeEscalationSweep();
  console.info("[cron:dispute-escalation]", JSON.stringify(result));
  return ok(result);
});

/** Health probe so a scheduler can verify wiring without escalating anything. */
export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
