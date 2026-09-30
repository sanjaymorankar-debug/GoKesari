/**
 * A delivery partner's actions on a return pickup: accept / reject an offer,
 * set off, confirm the pickup with the customer's handover code, or report
 * that it could not be completed.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { acceptPickup, confirmPickup, failPickup, rejectPickup, startPickup } from "@/server/services/return-pickups";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("reject"), reason: z.string().max(300).optional() }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("pickup"), code: z.string().min(1).max(8) }),
  z.object({ action: z.literal("fail"), reason: z.string().min(3).max(300) }),
]);

/** The rider never gets the handover code back in any response. */
const view = <T extends { handoverCode?: string; rejectedPartnerIds?: unknown }>(row: T) => {
  const { handoverCode: _c, rejectedPartnerIds: _r, ...safe } = row;
  void _c;
  void _r;
  return safe;
};

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "accept":
      return ok(view(await acceptPickup(id, user.id)));
    case "reject":
      return ok(view(await rejectPickup(id, user.id, body.reason)));
    case "start":
      return ok(view(await startPickup(id, user.id)));
    case "pickup":
      return ok(view(await confirmPickup(id, user.id, body.code)));
    case "fail":
      return ok(view(await failPickup(id, user.id, body.reason)));
  }
});
