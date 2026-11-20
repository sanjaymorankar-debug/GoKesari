/** POST { memberId, bookingId } → start (or reopen) the consultation for a booking (verified doctors only). */
import type { NextRequest } from "next/server";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { startConsultation } from "@/server/health/consultations";
import { bodyOf } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireHealthEnabled();
  enforceRateLimit(`health-consult:${user.id}`, RATE_LIMITS.MUTATION);
  return ok({ consultation: await startConsultation(await bodyOf(request), user) }, 201);
});
