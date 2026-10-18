/**
 * Sign-in housekeeping (batch-2026-10 WS-A, F1.1.2): deletes expired and used
 * one-time codes (rule otpHousekeeping). Schedule hourly:
 *   curl -X POST https://<host>/api/cron/auth-housekeeping -H "Authorization: Bearer $CRON_SECRET"
 * Idempotent.
 */
import type { NextRequest } from "next/server";

import { assertCronAuthorized } from "@/server/api/cron-auth";
import { ok, route } from "@/server/api/handler";
import { RATE_LIMITS, clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { purgeExpiredOtps } from "@/server/otp/housekeeping";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "cron"), RATE_LIMITS.CRON);
  assertCronAuthorized(request);
  const otps = await purgeExpiredOtps();
  console.info("[cron:auth-housekeeping]", JSON.stringify({ otps }));
  return ok({ otps });
});

export const GET = route(async (request: NextRequest) => {
  assertCronAuthorized(request);
  return ok({ status: "ready" });
});
