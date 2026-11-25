/**
 * Checkout step-up code (docs/sms-2fa-2026-11, rule checkoutOtp).
 *
 * GET              → { required, satisfied, mode, hours, needsPhone, maskedPhone }
 * POST { mobile? } → sends a code by SMS to the verified mobile (or to `mobile`
 *                    when the account has none yet) → { maskedPhone, resendAfterSeconds, expiryMinutes }
 * Verify with POST /api/checkout/otp/verify.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { checkoutStepUpState, requestCheckoutOtp } from "@/server/otp/checkout-step-up";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  return ok(await checkoutStepUpState(user.id));
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  const rules = await getRule("otp");
  enforceRateLimit(`checkout-otp:${user.id}`, { limit: rules.maxResendsPerWindow, windowMs: rules.resendWindowMinutes * 60_000 });
  const body = await parseBody(request, z.object({ mobile: z.string().trim().max(20).nullish() }));
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok(await requestCheckoutOtp({ userId: user.id, mobile: body.mobile, ip }));
});
