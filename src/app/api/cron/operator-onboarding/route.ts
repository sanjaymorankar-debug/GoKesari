/**
 * Operator-Limited onboarding safety net (batch-2026-10 WS-D, F8.4.2). Schedule every 5 minutes:
 *   curl -X POST https://<host>/api/cron/operator-onboarding -H "Authorization: Bearer $CRON_SECRET"
 *
 * A captured fee is recorded by the payment's own capture transaction and the
 * auto-approval check runs right after it; this only catches what fell
 * through: a fee whose payment failed or whose link expired (the shop stays
 * pending, an administrator is told) and an after-capture step that did not
 * run. Idempotent; safe to overlap.
 */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { assertCronAuthorized } from "@/server/api/cron-auth";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { sweepOnboardingFees } from "@/server/services/operator-limited";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const result = await sweepOnboardingFees();
  console.info("[cron:operator-onboarding]", JSON.stringify(result));
  return ok(result);
});

export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
