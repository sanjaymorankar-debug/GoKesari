/**
 * One home-care visit, provider side (the practice owner, the assigned member, staff; anyone else 404).
 * GET → booking, address, instructions, the patient's records only when shared for this booking (logged).
 * POST { action }: accept · decline {reason} · on-the-way {latitude?, longitude?} · location {latitude, longitude}
 *   · check-in {code} · check-out {code, notes, vitals?, photos?, photoConsent?} · reassign {memberId}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { careVisitForProvider, checkInVisit, checkOutVisit, decideCareVisit, reassignCareVisit, startOnTheWay, updateVisitLocation } from "@/server/health/care";
import { bodyOf, ipOf, str, uuidParam } from "@/server/health/http";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await careVisitForProvider(await uuidParam(context, "id"), user, ipOf(request)));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = await uuidParam(context, "id");
  const body = await bodyOf(request);
  const action = str(body, "action");
  // Location pings (every ~30 s) get their own bucket so they never starve the real actions.
  enforceRateLimit(action === "location" ? `health-care-loc:${user.id}` : `health-care-provider:${user.id}`, RATE_LIMITS.MUTATION);
  switch (action) {
    case "accept":
      return ok(await decideCareVisit(id, true, user, null));
    case "decline":
      return ok(await decideCareVisit(id, false, user, str(body, "reason")));
    case "on-the-way": {
      const loc = typeof body.latitude === "number" && typeof body.longitude === "number" ? { latitude: body.latitude, longitude: body.longitude } : null;
      const v = await startOnTheWay(id, loc, user);
      return ok({ status: v.status });
    }
    case "location":
      return ok(await updateVisitLocation(id, body, user));
    case "check-in": {
      const v = await checkInVisit(id, str(body, "code"), user);
      return ok({ status: v.status });
    }
    case "check-out": {
      const r = await checkOutVisit(id, body, user);
      return ok({ status: r.visit.status, documentId: r.documentId, bookingCompleted: r.bookingCompleted });
    }
    case "reassign": {
      const v = await reassignCareVisit(id, z.string().uuid().parse(body.memberId), user);
      return ok({ memberId: v.memberId });
    }
    default:
      throw validationFailed("Unknown action.");
  }
});
