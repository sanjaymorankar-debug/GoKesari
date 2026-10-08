/**
 * Live tracking (event layer): the rider's position for one delivery, posted
 * every `tracking.riderPingSeconds` from the moment the drop starts. Only the
 * rider holding the delivery may post; once it is delivered, failed or
 * cancelled nothing is stored and `sharing: false` tells the phone to stop.
 * Browser geolocation only — never a Google Maps Platform call.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { recordDeliveryLocation } from "@/server/services/delivery-assignment";

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  // Room for a 5-second cadence with retries, and no more.
  enforceRateLimit(`delivery-order-location:${user.id}`, { limit: 30, windowMs: 60_000 });
  const { id } = paramsSchema.parse(await context.params);
  const body = await parseBody(request, bodySchema);
  return ok(await recordDeliveryLocation(id, user.id, body.latitude, body.longitude));
});
