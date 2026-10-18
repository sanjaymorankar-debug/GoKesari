/**
 * F3.3.2 (batch-2026-10 WS-B): accept or decline a broadcast offer. The first
 * rider to accept gets the order; a later accept answers 409 with
 * `error.details.reason = "OFFER_TAKEN"`.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { toRiderView } from "@/server/services/delivery-assignment";
import { acceptBroadcastOffer, declineBroadcastOffer } from "@/server/services/dispatch-broadcast";

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ action: z.enum(["accept", "decline"]) });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const { id } = paramsSchema.parse(await context.params);
  const body = await parseBody(request, bodySchema);
  if (body.action === "accept") return ok(toRiderView(await acceptBroadcastOffer(id, user.id)));
  await declineBroadcastOffer(id, user.id);
  return ok({ declined: true });
});
