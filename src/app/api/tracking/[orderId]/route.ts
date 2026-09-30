import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { forbidden, notFound } from "@/lib/errors";
import { parseCoordinates } from "@/lib/geo/haversine";
import { buildOrderTracking } from "@/lib/tracking";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  orders,
  shops,
  type DeliveryOrderStatus,
} from "@/server/db/schema";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ orderId: z.string().uuid() });

const RIDER_ASSIGNED_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set([
  "ACCEPTED",
  "PICKED_UP",
  "DELIVERED",
  "FAILED",
]);

export const GET = route(
  async (_request: NextRequest, context: RouteContext<{ orderId: string }>) => {
    const user = await requireUser();
    const { orderId } = paramsSchema.parse(await context.params);

    const [row] = await db
      .select({
        orderStatus: orders.status,
        customerId: orders.userId,
        deliveryAddress: orders.deliveryAddressSnapshot,
        shopOwnerId: shops.ownerId,
        shopDeliveryAvailable: shops.deliveryAvailable,
        deliveryStatus: deliveryOrders.status,
        pickedUpAt: deliveryOrders.pickedUpAt,
        riderUserId: deliveryPartners.userId,
        riderLatitude: deliveryPartners.lastLocationLatitude,
        riderLongitude: deliveryPartners.lastLocationLongitude,
        riderLocationAt: deliveryPartners.lastLocationAt,
      })
      .from(orders)
      .innerJoin(shops, eq(orders.shopId, shops.id))
      .leftJoin(deliveryOrders, eq(deliveryOrders.orderId, orders.id))
      .leftJoin(deliveryPartners, eq(deliveryOrders.deliveryPartnerId, deliveryPartners.id))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!row) throw notFound("Order");

    const isAssignedRider =
      row.riderUserId === user.id &&
      row.deliveryStatus !== null &&
      RIDER_ASSIGNED_STATUSES.has(row.deliveryStatus);
    const allowed =
      row.customerId === user.id ||
      row.shopOwnerId === user.id ||
      can(user.role, PERMISSIONS.ORDER_VIEW_ANY) ||
      isAssignedRider;
    if (!allowed) throw forbidden("You do not have access to this order.");

    const riderCoords = parseCoordinates(row.riderLatitude, row.riderLongitude);

    return ok(
      buildOrderTracking({
        orderId,
        orderStatus: row.orderStatus,
        shopDispatchesRiders: row.shopDeliveryAvailable,
        delivery: row.deliveryStatus ? { status: row.deliveryStatus, pickedUpAt: row.pickedUpAt } : null,
        riderFix: riderCoords && row.riderLocationAt ? { ...riderCoords, recordedAt: row.riderLocationAt } : null,
        destination: parseCoordinates(row.deliveryAddress?.latitude, row.deliveryAddress?.longitude),
        now: new Date(),
      }),
    );
  },
);
