/**
 * F11: the signed-in customer's referral code and results (GET), and applying
 * a friend's code (POST { code }) — new customers only, before their first order.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { applyReferralCode, getReferralSummary } from "@/server/services/customer-referrals";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await getReferralSummary(user.id));
});

const schema = z.object({ code: z.string().trim().min(4).max(16) });

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`referral-apply:${user.id}`, RATE_LIMITS.MUTATION);
  const { code } = await parseBody(request, schema);
  const row = await applyReferralCode(user.id, code);
  return ok({ id: row.id, status: row.status }, 201);
});
