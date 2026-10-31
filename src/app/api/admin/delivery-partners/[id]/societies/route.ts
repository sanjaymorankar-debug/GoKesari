/**
 * Gig worker flow (features 7 and 8): GoKesari admin authorises or blocks a
 * delivery partner per society. GET lists both; PUT sets one decision
 * ({ societyId, access, reason }); DELETE ?societyId= removes it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import {
  clearSocietyPartnerAccess,
  getPartnerSocietyAccessForAdmin,
  setSocietyPartnerAccess,
} from "@/server/services/society-partner-access";

export const dynamic = "force-dynamic";

const schema = z.object({
  societyId: z.string().uuid(),
  access: z.enum(["AUTHORISED", "BLOCKED"]),
  reason: z.string().max(500).nullish(),
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  return ok(await getPartnerSocietyAccessForAdmin(id, user));
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await setSocietyPartnerAccess({ ...body, deliveryPartnerId: id }, user));
});

export const DELETE = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  const societyId = new URL(request.url).searchParams.get("societyId");
  if (!societyId) throw validationFailed("societyId is required.");
  await clearSocietyPartnerAccess(societyId, id, user);
  return ok({ removed: true });
});
