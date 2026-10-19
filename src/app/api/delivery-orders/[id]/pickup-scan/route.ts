/**
 * F4.1.3 (batch-2026-10 WS-B): the rider scanned the shop's pickup QR for this
 * delivery. Valid → PICKED_UP (customer told at once), with the scan's time and
 * the rider's location recorded. Refusals carry `error.details.reason`
 * (BAD_SIGNATURE, EXPIRED, ALREADY_USED, WRONG_RIDER, …) and
 * `fallback: "PICKUP_CODE"` — the typed code (PATCH /api/delivery-orders/[id],
 * action "pickup") still works.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { scanPickupQr } from "@/server/services/pickup-qr";

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({
  payload: z.string().min(1).max(512),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  accuracyM: z.number().min(0).max(100_000).nullish(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  enforceRateLimit(`delivery-pickup-scan:${user.id}`, { limit: 20, windowMs: 60_000 });
  const { id } = paramsSchema.parse(await context.params);
  const body = await parseBody(request, bodySchema);
  return ok(
    await scanPickupQr({
      deliveryOrderId: id,
      actor: user,
      payload: body.payload,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      accuracyM: body.accuracyM ?? null,
    }),
  );
});
