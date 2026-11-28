/**
 * 0231 (v3 order, owner 28-Nov-2026): a guest on /shop/register gives the referral code first, before the login
 * sheet. POST { code: string | null } — checked with the REFERRAL step's own rule (assertRegistrationReferralCode:
 * a code the admin setting requires, an unknown or closed code refused). Answers { code } as it will be saved.
 * No session needed; limited per network address (codes are short, so this is a guessing surface).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { checkGuestShopReferral } from "@/server/onboarding-v2/early-agreement";
import { onboardingV2Enabled } from "@/server/onboarding-v2/roles";
import { notFound } from "@/lib/errors";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().max(40).nullable() });

export const POST = route(async (request: NextRequest) => {
  if (!(await onboardingV2Enabled())) throw notFound("Page");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  enforceRateLimit(`guest-shop-referral:${ip}`, RATE_LIMITS.VOUCHER_PREVIEW);
  const body = await parseBody(request, schema);
  return ok(await checkGuestShopReferral(body.code || null));
});
