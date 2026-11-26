/**
 * Onboarding WP7 (docs/onboarding-waves-2-3-2026-11): POST { ownerId } — the owner pays the registration
 * fee on their own phone: a payment link (and its QR code) for what is due on the shop the helper's assisted
 * draft created; the owner is sent the link too. Only the helper recorded on the draft. Flag off → 404.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { assistedFeeLink } from "@/server/services/assisted-onboarding";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`assisted-onboarding-fee:${user.id}`, RATE_LIMITS.PAYMENT);
  const body = await parseBody(request, z.object({ ownerId: z.string().uuid() }));
  return ok(await assistedFeeLink(user, body.ownerId));
});
