/**
 * Onboarding WP7 (docs/onboarding-waves-2-3-2026-11): POST { ownerId } — a dealer, dealer employee or
 * operator who holds a valid owner-consent session opens the owner's registration wizard draft as the
 * helper; the helper's referral code is locked onto it. Then the wizard routes are called with the header
 * x-gk-assist-owner: <ownerId>. The consent session (dealer-assisted or operator onboarding) is the
 * permission: no session of this helper for this owner → 403. Flag onboarding_assisted_mode_enabled off → 404.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { startAssistedDraft } from "@/server/services/assisted-onboarding";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`assisted-onboarding:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ ownerId: z.string().uuid() }));
  return ok(await startAssistedDraft(user, body.ownerId));
});
