/**
 * A doctor's details (registration, council, qualifications) and pad tools.
 * POST { action: profile {...} | template {...} | delete-template {id} }; GET ?view=templates
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { saveDoctorProfile } from "@/server/health/doctors";
import { bodyOf, uuidParam } from "@/server/health/http";
import { deleteTemplate, listTemplates, saveTemplate } from "@/server/health/templates";

export const dynamic = "force-dynamic";

export const GET = route(async (_r: NextRequest, context: RouteContext<{ memberId: string }>) => {
  const user = await requireUser();
  return ok({ templates: await listTemplates(await uuidParam(context, "memberId"), user) });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ memberId: string }>) => {
  const user = await requireUser();
  await requireHealthEnabled();
  enforceRateLimit(`health-doctor:${user.id}`, RATE_LIMITS.MUTATION);
  const memberId = await uuidParam(context, "memberId");
  const body = await bodyOf(request);
  switch (body.action) {
    case "profile": {
      const { signatureImage: _s, stampImage: _t, ...profile } = await saveDoctorProfile(memberId, body, user);
      void _s;
      void _t;
      return ok({ profile });
    }
    case "template":
      return ok({ template: await saveTemplate(memberId, body, user) });
    case "delete-template":
      await deleteTemplate(memberId, z.string().uuid().parse(body.id), user);
      return ok({ deleted: true });
    default:
      throw validationFailed("Unknown action.");
  }
});
