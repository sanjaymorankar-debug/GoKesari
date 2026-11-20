/**
 * POST — GoKesari Health Prime call tracking: the telephony provider reports one call on a clinic's virtual
 * number. JSON { callId, virtualNumber, caller, startedAt, durationSeconds, status: ANSWERED | MISSED },
 * signed: header x-gokesari-signature = hex HMAC-SHA256 of the raw body with HEALTH_TELEPHONY_WEBHOOK_SECRET.
 * Without the secret only the mock provider outside production is accepted. Idempotent per callId.
 */
import type { NextRequest } from "next/server";

import { forbidden, validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { recordTelephonyCall, TELEPHONY_SIGNATURE_HEADER, verifyTelephonyRequest } from "@/server/health/telephony";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "health-telephony"), { limit: 600, windowMs: 60_000 });
  const raw = await request.text();
  const check = await verifyTelephonyRequest(raw, request.headers.get(TELEPHONY_SIGNATURE_HEADER));
  if (!check.ok) throw forbidden(check.reason);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw validationFailed("Request body must be valid JSON.");
  }
  const result = await recordTelephonyCall(body);
  return ok({ logged: result.logged, reason: result.reason ?? null });
});
