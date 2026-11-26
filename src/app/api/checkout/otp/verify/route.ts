/**
 * POST { code, mobile? } → verifies the checkout step-up code (docs/sms-2fa-2026-11)
 * → { mode, validUntil }. `mobile` only when the code was sent to a number the
 * account did not have verified yet; it is saved as the verified mobile.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { verifyCheckoutOtp } from "@/server/otp/checkout-step-up";

export const dynamic = "force-dynamic";

const schema = z.object({
  code: z.string().trim().min(1).max(12),
  mobile: z.string().trim().max(20).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.ORDER_PLACE);
  enforceRateLimit(`checkout-otp-verify:${user.id}`, { limit: 20, windowMs: 15 * 60_000 });
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok(await verifyCheckoutOtp({ userId: user.id, code: body.code, mobile: body.mobile, ip }));
});
