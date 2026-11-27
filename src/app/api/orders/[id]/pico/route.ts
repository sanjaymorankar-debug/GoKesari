/**
 * The order's gokesari.com delivery partner (Pico Xpress) shipment (docs/pico-xpress-2026-11).
 *
 *   GET   the customer: status timeline, rider, ETA (IST), tracking link, delivery code;
 *         the shop (orders.view) / operations: the shipment, the shop's pickup code;
 *         ?check=1 (shop / operations): whether the option can be offered now (Pico serviceability).
 *   POST  { action: "book", ewayBillNo?, numBoxes? }       shop (orders.edit) or operations — book / book again
 *         { action: "cancel", reason }                     shop or operations — only before pickup
 *         { action: "refresh" }                            operations — pull the status from Pico
 */
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { requireShopPermission } from "@/server/authz/shop-permission";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { canSeeDelivery } from "@/server/delivery/access";
import { bookPicoShipment, cancelPicoShipment, picoOptionForOrder, refreshPicoShipment } from "@/server/delivery/pico/service";
import { adminPicoView, buyerPicoViews, shopPicoViews } from "@/server/delivery/pico/views";
import { getRule } from "@/server/services/settings";

export const dynamic = "force-dynamic";

const body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("book"),
    ewayBillNo: z.string().trim().regex(/^\d{12}$/, "The e-way bill number has 12 digits.").nullish(),
    numBoxes: z.number().int().min(1).max(20).nullish(),
  }),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(3, "Say why.").max(200) }),
  z.object({ action: z.literal("refresh") }),
]);

async function load(id: string) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, id), columns: { id: true, shopId: true, userId: true } });
  if (!order) throw notFound("Order");
  return order;
}

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const order = await load(id);
  if (order.userId === user.id) {
    return ok({ role: "customer", shipment: (await buyerPicoViews([id])).get(id) ?? null });
  }
  await requireShopPermission(order.shopId, "orders.view", { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
  const check = request.nextUrl.searchParams.get("check") === "1";
  const option = check ? await picoOptionForOrder(id) : null;
  const ops = canSeeDelivery(user.role);
  const shipment = ops ? await adminPicoView(id) : ((await shopPicoViews([id])).get(id) ?? null);
  return ok({ role: ops ? "operations" : "shop", option, shipment, cancelReasons: ops ? (await getRule("picoXpress")).cancelReasons : null });
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const order = await load(id);
  enforceRateLimit(`pico-order:${user.id}`, RATE_LIMITS.MUTATION);
  const input = await parseBody(request, body);
  const ops = canSeeDelivery(user.role);
  if (input.action === "refresh") {
    if (!ops) throw forbidden("Only operations can refresh the delivery status.");
    const result = await refreshPicoShipment(id);
    return ok({ result, shipment: await adminPicoView(id) });
  }
  if (order.userId === user.id && !ops) throw forbidden("Cancel the order itself from My Orders.");
  await requireShopPermission(order.shopId, "orders.edit", { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
  const actor = { id: user.id, role: user.role };
  if (input.action === "book") {
    const result = await bookPicoShipment(id, actor, { ewayBillNo: input.ewayBillNo, numBoxes: input.numBoxes });
    return ok({ result, shipment: (await shopPicoViews([id])).get(id) ?? null });
  }
  if (ops) {
    const reasons = (await getRule("picoXpress")).cancelReasons;
    if (!reasons.includes(input.reason)) throw validationFailed("Choose one of the listed reasons.", { fields: { reason: "Choose a reason." } });
  }
  const result = await cancelPicoShipment(id, ops ? "ADMIN" : "SHOP", input.reason, actor);
  return ok({ result, shipment: ops ? await adminPicoView(id) : ((await shopPicoViews([id])).get(id) ?? null) });
});
