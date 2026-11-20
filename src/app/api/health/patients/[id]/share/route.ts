/** POST { objectType: PRESCRIPTION|DOCUMENT, objectId } → an expiring share link; DELETE → revoke all my links. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { bodyOf, uuidParam } from "@/server/health/http";
import { createShareLink, revokeShareLinks } from "@/server/health/records";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`health-share:${user.id}`, RATE_LIMITS.MUTATION);
  const body = z.object({ objectType: z.enum(["PRESCRIPTION", "DOCUMENT"]), objectId: z.string().uuid() }).parse(await bodyOf(request));
  return ok(await createShareLink(await uuidParam(context, "id"), body.objectType, body.objectId, user), 201);
});

export const DELETE = route(async (_r: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  return ok({ revoked: await revokeShareLinks(await uuidParam(context, "id"), user) });
});
