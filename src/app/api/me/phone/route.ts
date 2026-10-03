/**
 * The signed-in user's login mobile number.
 * PUT { mobile } links it (10-digit Indian number; not verified — codes go by email); DELETE removes it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { linkPhone, unlinkPhone } from "@/server/otp/service";

export const dynamic = "force-dynamic";

const schema = z.object({ mobile: z.string().min(10).max(20) });

export const PUT = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`phone-link:${user.id}`, RATE_LIMITS.SHOP_IDENTITY_CHECK);
  return ok(await linkPhone(user.id, user.role, await parseBody(request, schema)));
});

export const DELETE = route(async () => {
  const user = await requireUser();
  await unlinkPhone(user.id, user.role);
  return ok({ removed: true });
});
