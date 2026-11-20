/**
 * Record-sharing consent: GET → every consent of this person; POST { memberId, mode: ALWAYS|ASK|OFF|THIS_BOOKING,
 * bookingId? } → set the choice for one doctor / provider (withdrawal takes effect at once).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { consentsFor, setDoctorConsent } from "@/server/health/consent";
import { bodyOf, uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok({ consents: await consentsFor(await uuidParam(context, "id"), user) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`health-consent:${user.id}`, RATE_LIMITS.MUTATION);
  const body = z.object({ memberId: z.string().uuid(), mode: z.enum(["ALWAYS", "ASK", "OFF", "THIS_BOOKING"]), bookingId: z.string().uuid().nullish() }).parse(await bodyOf(request));
  return ok({ id: await setDoctorConsent({ patientId: await uuidParam(context, "id"), ...body }, user) }, 201);
});
