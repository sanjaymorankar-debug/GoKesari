/**
 * "Shop is open now" alerts for orders placed while the shop was closed.
 *
 * A customer who confirms ordering from a closed shop gets an order flagged
 * `placed_while_closed`; the shop is alerted immediately at checkout (see
 * orders.ts). This sweep sends the SECOND alert, exactly once, when the shop is
 * open again and the order is still waiting for acceptance. Run it every
 * minute from the notifications cron. Safe to overlap — each order is claimed
 * with a conditional UPDATE, so two overlapping sweeps never alert twice.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";

import { isShopOpenNow } from "@/lib/shop-hours";
import { db } from "@/server/db";
import { orders, shops } from "@/server/db/schema";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { updateReturning } from "@/server/db/returning";

export interface ShopOpeningSweepResult {
  shopsAlerted: number;
  ordersAlerted: number;
}

export async function sendShopOpeningAlerts(
  now: Date = new Date(),
): Promise<ShopOpeningSweepResult> {
  // Orders that moved on (accepted, cancelled, ...) while the shop was closed no longer need the alert.
  await db
    .update(orders)
    .set({ shopOpenAlertSentAt: now })
    .where(
      and(
        eq(orders.placedWhileClosed, true),
        isNull(orders.shopOpenAlertSentAt),
        ne(orders.status, "CONFIRMED"),
      ),
    );

  const pending = await db
    .select({ order: orders, shop: shops })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(orders.placedWhileClosed, true),
        isNull(orders.shopOpenAlertSentAt),
        eq(orders.status, "CONFIRMED"),
      ),
    );

  const openNow = pending.filter((row) => isShopOpenNow(row.shop, now));
  if (openNow.length === 0) return { shopsAlerted: 0, ordersAlerted: 0 };

  // Claim first; only the sweep that wins the claim sends the alert.
  const claimed = await updateReturning(
    db,
    orders,
    { shopOpenAlertSentAt: now },
    and(
      inArray(
        orders.id,
        openNow.map((r) => r.order.id),
      ),
      isNull(orders.shopOpenAlertSentAt),
    ),
  );
  const claimedIds = new Set(claimed.map((c) => c.id));

  const byShop = new Map<string, typeof openNow>();
  for (const row of openNow) {
    if (!claimedIds.has(row.order.id)) continue;
    byShop.set(row.shop.id, [...(byShop.get(row.shop.id) ?? []), row]);
  }

  for (const rows of byShop.values()) {
    const { shop } = rows[0];
    try {
      await notify({
        userId: shop.ownerId,
        type: NOTIFICATION_TYPES.SHOP_OPENED_ORDERS_WAITING,
        title: "Your shop is open — orders are waiting",
        body: `${rows.length} order${rows.length === 1 ? "" : "s"} placed while ${shop.name} was closed ${rows.length === 1 ? "is" : "are"} waiting for you to accept: ${rows.map((r) => r.order.orderNumber).join(", ")}.`,
        actionUrl: "/shop/orders",
      });
      for (const { order } of rows) {
        await notify({
          userId: order.userId,
          type: NOTIFICATION_TYPES.ORDER_SHOP_NOW_OPEN,
          title: "The shop is open now",
          body: `${shop.name} is open now and can accept your order ${order.orderNumber}.`,
          actionUrl: "/orders",
        });
      }
    } catch (err) {
      // The claim is already recorded; a failed notification must not break the sweep.
      console.error(
        "[shop-opening] notify failed",
        shop.id,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { shopsAlerted: byShop.size, ordersAlerted: claimed.length };
}
