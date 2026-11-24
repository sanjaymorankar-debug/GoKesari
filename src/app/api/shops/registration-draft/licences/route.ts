/**
 * Owner, 25-Nov-2026: POST { promise } answers the licences screen. Each licence is checked on
 * /registration-draft/documents first; `promise` covers the ones not given yet.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { wizardActor } from "@/server/api/wizard-actor";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { finishDraftLicences } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

const schema = z.object({ promise: z.boolean().default(false) });

export const POST = route(async (request: NextRequest) => {
  const user = await wizardActor(request);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(await finishDraftLicences({ actor: user, promise: body.promise }));
});
