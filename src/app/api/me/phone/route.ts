/**
 * The signed-in user's login mobile number.
 * PUT { mobile } links it (10-digit Indian number; not verified — codes go by email); DELETE removes it.
 * docs/flows-v3/wave5.md (flag flow_f18, where SMS codes can be sent): PUT also needs { code }, the SMS code sent
 * to the new number by POST /api/me/phone/code; without it the answer is 400 with details.reason PHONE_CODE_REQUIRED.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { linkPhoneChecked } from "@/server/flows/phone-link";
import { unlinkPhone } from "@/server/otp/service";

export const dynamic = "force-dynamic";

const schema = z.object({ mobile: z.string().min(10).max(20), code: z.string().trim().max(12).nullish() });

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`phone-link:${user.id}`, RATE_LIMITS.SHOP_IDENTITY_CHECK);
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  return ok(await linkPhoneChecked(user.id, user.role, { mobile: body.mobile, code: body.code ?? null }, ip));
});

export const DELETE = route(async () => {
  const user = await requireUser();
  await unlinkPhone(user.id, user.role);
  return ok({ removed: true });
});
