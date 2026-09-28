/**
 * Delivery-partner actions on a single delivery assignment (delivery-system
 * Part 58, Slice C; Slice 4 handover) — accept, reject, pick up (with the
 * shop's pickup code), start the drop (issues the customer OTP), deliver
 * (with the customer's OTP), or report a failed delivery. Deliberately a
 * separate endpoint from /api/orders/[id]/status, which is the existing,
 * unmodified shop-owner order-status flow.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  acceptDeliveryOffer,
  markDelivered,
  markDeliveryFailed,
  markPickedUp,
  rejectDeliveryOffer,
  startDelivery,
  toRiderView,
} from "@/server/services/delivery-assignment";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("reject"), reason: z.string().max(500).optional() }),
  z.object({ action: z.literal("pickup"), pickupCode: z.string().max(8).optional() }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("deliver"), otp: z.string().max(8).optional() }),
  z.object({ action: z.literal("fail"), reason: z.string().min(3).max(300) }),
]);

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
    const { id } = await context.params;
    const body = await parseBody(request, schema);

    switch (body.action) {
      case "accept":
        return ok(toRiderView(await acceptDeliveryOffer(id, user.id)));
      case "reject":
        return ok(toRiderView(await rejectDeliveryOffer(id, user.id, body.reason)));
      case "pickup":
        return ok(toRiderView(await markPickedUp(id, user, body.pickupCode)));
      case "start":
        return ok(toRiderView(await startDelivery(id, user)));
      case "deliver":
        return ok(toRiderView(await markDelivered(id, user, body.otp)));
      case "fail":
        return ok(toRiderView(await markDeliveryFailed(id, user, body.reason)));
    }
  },
);
