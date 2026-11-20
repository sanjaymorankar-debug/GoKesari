/** One person's health profile: GET → profile; POST → update (allergies, conditions, blood group, ABHA …). */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled, requirePatientAccess } from "@/server/health/access";
import { bodyOf, uuidParam } from "@/server/health/http";
import { updatePatientProfile } from "@/server/health/patients";

export const dynamic = "force-dynamic";

export const GET = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { linkCodeHash: _h, ...patient } = await requirePatientAccess(await uuidParam(context, "id"), user);
  void _h;
  return ok({ patient });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  await requireHealthEnabled();
  enforceRateLimit(`health-profile:${user.id}`, RATE_LIMITS.MUTATION);
  const { linkCodeHash: _h, ...patient } = await updatePatientProfile(await uuidParam(context, "id"), await bodyOf(request), user);
  void _h;
  return ok({ patient });
});
