/**
 * F4.2.2 (batch-2026-10 WS-B): the rider's turn-by-turn route for one of
 * their deliveries — to the shop until pickup, then to the customer. Only the
 * rider holding the delivery (403 otherwise); 404 while rule riderNavigation
 * is off. `lat`/`lng`: the rider's current position (re-routing after going
 * off the route); without them the last position on file is used.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getDeliveryNavigation } from "@/server/services/rider-navigation";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });
const querySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
  })
  .refine((q) => (q.lat == null) === (q.lng == null), { message: "Send both lat and lng, or neither." });

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  // Re-routing is throttled on the phone too (rule riderNavigation.rerouteCooldownSeconds).
  enforceRateLimit(`delivery-navigation:${user.id}`, { limit: 30, windowMs: 60_000 });
  const { id } = paramsSchema.parse(await context.params);
  const q = parseQuery(request, querySchema);
  const position = q.lat != null && q.lng != null ? { latitude: q.lat, longitude: q.lng } : null;
  return ok(await getDeliveryNavigation(id, user.id, position));
});
