/**
 * Owner, 25-Nov-2026: staff (admin, operations) act on an owner's unfinished registration.
 * POST { action: "resume-link" } sends the owner a link to carry on where it stopped.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { sendResumeLinkForStaff } from "@/server/registration/unfinished";

export const dynamic = "force-dynamic";

const schema = z.object({ action: z.literal("resume-link") });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const staff = await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  enforceRateLimit(`registration-resume-link:${staff.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  await parseBody(request, schema);
  await sendResumeLinkForStaff(id, staff, request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null);
  return ok({ sent: true });
});
