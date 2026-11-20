/**
 * GoKesari Health "Get medicines" (src/server/health/rx-orders.ts).
 * GET              → the signed-in user's medicine orders (all their records; ?patient=<id> for one)
 * GET ?shopId=<id> → the medical store's inbox (owner only)
 * POST             → send a prescription to a store {prescriptionId, shopId, items[{prescriptionItemId, qty}],
 *                    fulfilment PICKUP|DELIVERY, pickupAt?, addressId?, latitude?, longitude?, fromOrderId?}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { createRxOrder, myRxOrders, storeRxInbox } from "@/server/health/rx-orders";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const shopId = request.nextUrl.searchParams.get("shopId");
  if (shopId) return ok({ orders: await storeRxInbox(z.string().uuid().parse(shopId), user) });
  const patient = request.nextUrl.searchParams.get("patient");
  return ok({ orders: await myRxOrders(user, patient ? z.string().uuid().parse(patient) : null) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`health-rx-create:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await request.json().catch(() => ({}));
  const order = await createRxOrder(body, user);
  return ok({ order: { id: order.id, orderNumber: order.orderNumber, status: order.status, expiresAt: order.expiresAt } }, 201);
});
