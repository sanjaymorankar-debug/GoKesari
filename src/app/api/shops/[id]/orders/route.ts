/**
 * Module 10 (docs/shop-staff-roles-2026-11): the shop's recent orders, for the
 * owner, operations and — with flag shop_staff_roles_enabled on — staff holding
 * orders.view. GET ?status=
 * A compact view: number, status, time, items and total.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireShopPermission } from "@/server/authz/shop-permission";
import { PERMISSIONS } from "@/server/authz/permissions";
import { orderStatusEnum } from "@/server/db/schema";
import { listOrdersForShop } from "@/server/services/orders";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  await requireShopPermission(id, "orders.view", { anyPermission: PERMISSIONS.ORDER_UPDATE_STATUS_ANY });
  const status = z.enum(orderStatusEnum.enumValues).optional().catch(undefined).parse(request.nextUrl.searchParams.get("status") ?? undefined);
  const rows = await listOrdersForShop(id, { status, limit: 100 });
  return ok({
    orders: rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      createdAt: o.createdAt,
      totalPaise: o.totalPaise,
      items: o.items.map((i) => ({ id: i.id, name: i.productNameSnapshot, unit: i.unitSnapshot, quantityMilli: i.quantityMilli, fulfilmentStatus: i.fulfilmentStatus })),
    })),
  });
});
