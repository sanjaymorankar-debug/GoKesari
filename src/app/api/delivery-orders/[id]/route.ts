/**
 * Delivery-partner actions on a single delivery assignment (delivery-system
 * Part 58, Slice C; Slice 4 handover) — accept, reject, pick up (with the
 * shop's pickup code), start the drop (issues the customer OTP), deliver
 * (with the customer's OTP), or report a failed delivery. Checkpoints
 * `arrived_shop` and `arrived_customer` record progress without changing the
 * order status. Deliberately a
 * separate endpoint from /api/orders/[id]/status, which is the existing,
 * unmodified shop-owner order-status flow.
 *
 * Module 4 (23-Nov-2026): `deliver` and `fail` take an optional position
 * (latitude, longitude, accuracyM — stored only while rule
 * deliveryProof.captureGps is on); `fail` takes an optional `reasonCode` from
 * the fixed list (rule deliveryProof.failureReasons), with `reason` then an
 * optional note. A free-text `reason` alone works as before.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { FAILURE_REASON_CODES } from "@/lib/delivery/failure-reasons";
import { RIDER_REJECT_REASONS } from "@/lib/rider-reject-reasons";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  acceptDeliveryOffer,
  markArrivedAtCustomer,
  markArrivedAtShop,
  markDelivered,
  markDeliveryFailed,
  markPickedUp,
  rejectDeliveryOffer,
  startDelivery,
  toRiderView,
} from "@/server/services/delivery-assignment";

const gps = {
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(1_000_000).optional(),
};

function positionOf(body: { latitude?: number; longitude?: number; accuracyM?: number }) {
  return body.latitude != null && body.longitude != null
    ? { latitude: body.latitude, longitude: body.longitude, accuracyM: body.accuracyM ?? null }
    : null;
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("reject"), reason: z.string().max(500).optional(), reasonCode: z.enum(RIDER_REJECT_REASONS).optional() }),
  z.object({ action: z.literal("arrived_shop") }),
  z.object({ action: z.literal("pickup"), pickupCode: z.string().max(8).optional() }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("arrived_customer") }),
  z.object({ action: z.literal("deliver"), otp: z.string().max(8).optional(), cashCollected: z.boolean().optional(), ...gps }),
  z
    .object({
      action: z.literal("fail"),
      reason: z.string().max(300).optional(),
      reasonCode: z.enum(FAILURE_REASON_CODES).optional(),
      ...gps,
    })
    // Without a code, the free-text reason is required as before (3+ characters).
    .refine((b) => b.reasonCode != null || (b.reason ?? "").trim().length >= 3, {
      message: "Say why the delivery could not be completed.",
      path: ["reason"],
    }),
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
        return ok(toRiderView(await rejectDeliveryOffer(id, user.id, body.reason, body.reasonCode)));
      case "arrived_shop":
        return ok(toRiderView(await markArrivedAtShop(id, user)));
      case "arrived_customer":
        return ok(toRiderView(await markArrivedAtCustomer(id, user)));
      case "pickup":
        return ok(toRiderView(await markPickedUp(id, user, body.pickupCode)));
      case "start":
        return ok(toRiderView(await startDelivery(id, user)));
      case "deliver":
        return ok(toRiderView(await markDelivered(id, user, body.otp, body.cashCollected, positionOf(body))));
      case "fail":
        return ok(
          toRiderView(await markDeliveryFailed(id, user, body.reason, { reasonCode: body.reasonCode, position: positionOf(body) })),
        );
    }
  },
);
