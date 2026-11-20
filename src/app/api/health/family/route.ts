/** POST → add a family member: a dependent at once, an adult after their one-time code. */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { bodyOf } from "@/server/health/http";
import { addFamilyMember } from "@/server/health/patients";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireHealthEnabled();
  enforceRateLimit(`health-family:${user.id}`, RATE_LIMITS.MUTATION);
  const { patient, codeSentTo } = await addFamilyMember(await bodyOf(request), user);
  return ok({ patient: { id: patient.id, fullName: patient.fullName, relation: patient.relation, linkStatus: patient.linkStatus }, codeSentTo }, 201);
});
