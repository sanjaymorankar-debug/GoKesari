/**
 * 0231 (v3 order, owner 28-Nov-2026), after go-live:
 *   POST { action: "licences" }  the licences screen is answered (upload now on My shop → Documents, or later — the
 *                                documents follow-up chases them); the wizard moves on to products.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { answerV3PostLiveLicences } from "@/server/onboarding-v2/early-agreement";

export const dynamic = "force-dynamic";

const schema = z.object({ action: z.literal("licences") });

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  await parseBody(request, schema);
  return ok(await answerV3PostLiveLicences(user));
});
