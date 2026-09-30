/**
 * Ratings for one of your own orders (GS-059/060).
 * GET — eligibility and what you already rated. POST — rate the shop or rider.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getRatingEligibility, submitRating } from "@/server/services/ratings";

const schema = z.object({
  target: z.enum(["SHOP", "DELIVERY_PARTNER"]),
  score: z.number().int().min(1).max(5),
  comment: z.string().max(500).nullish(),
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.RATING_CREATE_OWN);
  const { id } = await context.params;
  const e = await getRatingEligibility(id, user.id);
  // Never expose the rider's id to the customer.
  return ok({
    canRateShop: e.canRateShop,
    canRateRider: e.canRateRider,
    reason: e.reason,
    shopScore: e.existing.shop?.score ?? null,
    riderScore: e.existing.rider?.score ?? null,
  });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.RATING_CREATE_OWN);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const rating = await submitRating({ orderId: id, ...body }, user);
  return ok({ id: rating.id, target: rating.targetType, score: rating.score }, 201);
});
