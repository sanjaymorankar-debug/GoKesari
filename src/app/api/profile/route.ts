/**
 * The signed-in user's own details.
 * GET → profile; PATCH { name?, gender?, mobile?, markComplete? } updates it.
 * The email address changes through /api/profile/email (it needs a fresh code).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { GENDERS, getProfile, updateProfile } from "@/server/services/profile";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().max(100).nullish(),
  gender: z.enum(GENDERS).nullish(),
  mobile: z.string().max(20).nullish(),
  markComplete: z.boolean().optional(),
});

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await getProfile(user.id));
});

export const PATCH = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`profile:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  return ok(
    await updateProfile(user.id, user.role, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.gender !== undefined ? { gender: body.gender } : {}),
      ...(body.mobile !== undefined ? { mobile: body.mobile } : {}),
      markComplete: body.markComplete,
    }),
  );
});
