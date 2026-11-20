/**
 * A prescription. GET → the view for the patient / issuing doctor / store it was sent to.
 * POST { action: "amend", reason, items, suggestions?, acknowledgeWarnings? } (issuing doctor) → a new version.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { bodyOf, ipOf, uuidParam } from "@/server/health/http";
import { amendPrescription, prescriptionView } from "@/server/health/prescriptions";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok(await prescriptionView(await uuidParam(context, "id"), user, ipOf(request)));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`health-rx:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await bodyOf(request);
  if (body.action !== "amend") throw validationFailed("Unknown action.");
  return ok(await amendPrescription(await uuidParam(context, "id"), body, user));
});
