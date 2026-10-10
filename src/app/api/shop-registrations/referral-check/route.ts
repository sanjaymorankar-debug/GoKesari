/**
 * POST { code } → is the referral code usable, and the fee plans to choose
 * from (Module 3). Same answer shape for every failure; only the message
 * differs. Public, rate-limited. A blank code is accepted (code: null) while
 * the admin's setting referral_required_shop is OPTIONAL
 * (docs/nearby-referral-2026-10), refused (reason REQUIRED) while MANDATORY.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { assertSelfRegistrationOpen, checkJoinReferral } from "@/server/registration/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  enforceRateLimit(clientKey(request, "referral-check"), { limit: 30, windowMs: 10 * 60_000 });
  await assertSelfRegistrationOpen();
  const { code } = await parseBody(request, z.object({ code: z.string().trim().max(40).nullish() }));
  return ok(await checkJoinReferral(code));
});
