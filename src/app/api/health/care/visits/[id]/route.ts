/**
 * One home-care visit, patient side (the account holder / linked adult of the patient; anyone else 404).
 * GET → status, provider card and ID card, OTP codes, live "on the way" (distance / ETA), notes, package.
 * POST { action }: sos {latitude?, longitude?} · rate {rating, review?} · complain {reason} · cancel {reason?}
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { cancelCareVisit, careSos, careVisitForPatient, complainCareVisit, rateCareVisit } from "@/server/health/care";
import { bodyOf, str, uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await careVisitForPatient(await uuidParam(context, "id"), user));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "id");
  const body = await bodyOf(request);
  const action = str(body, "action");
  enforceRateLimit(`health-care-visit:${user.id}`, RATE_LIMITS.MUTATION);
  switch (action) {
    case "sos":
      return ok(await careSos(id, { latitude: typeof body.latitude === "number" ? body.latitude : null, longitude: typeof body.longitude === "number" ? body.longitude : null }, user));
    case "rate":
      await rateCareVisit(id, body, user);
      return ok({ ok: true });
    case "complain": {
      const r = await complainCareVisit(id, body, user);
      return ok({ ticketNumber: r.ticketNumber });
    }
    case "cancel":
      return ok(await cancelCareVisit(id, str(body, "reason"), user));
    default:
      throw validationFailed("Unknown action.");
  }
});
