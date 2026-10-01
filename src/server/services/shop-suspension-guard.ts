/**
 * Suspension guards that orders.ts and dispatch consult. Kept apart from
 * shop-suspension.ts (which itself cancels orders) so neither imports the other.
 */
import { and, desc, eq } from "drizzle-orm";

import { conflict } from "@/lib/errors";
import type { DbClient } from "@/server/db";
import { shopSuspensionOrders, shopSuspensions, shops, type UserRole } from "@/server/db/schema";

/** The suspension record for an order of a currently-suspended shop, if any. */
export async function suspensionRecordFor(client: DbClient, shopId: string, orderId: string) {
  const [shop] = await client.select({ status: shops.status }).from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.status !== "SUSPENDED") return { suspended: false as const, record: null };
  const [record] = await client
    .select({ outcome: shopSuspensionOrders.outcome })
    .from(shopSuspensionOrders)
    .innerJoin(shopSuspensions, eq(shopSuspensionOrders.suspensionId, shopSuspensions.id))
    .where(and(eq(shopSuspensionOrders.orderId, orderId), eq(shopSuspensions.status, "ACTIVE")))
    .orderBy(desc(shopSuspensionOrders.createdAt))
    .limit(1);
  return { suspended: true as const, record: record ?? null };
}

/**
 * A suspended shop cannot take new orders, and cannot move an order the policy
 * put under review. Orders the policy lets it finish (CONTINUING) proceed
 * normally. Operators, admins and riders are never blocked here.
 */
export async function assertShopMayProgress(
  client: DbClient,
  order: { id: string; shopId: string },
  newStatus: string,
  actor: { role: UserRole },
): Promise<void> {
  if (actor.role !== "SHOP_OWNER") return;
  const { suspended, record } = await suspensionRecordFor(client, order.shopId, order.id);
  if (!suspended) return;
  if (record?.outcome === "CONTINUING") return;
  if (record?.outcome === "AWAITING_REVIEW") {
    throw conflict("Your shop is suspended and this order is waiting for an operations decision. It will be resolved for you.");
  }
  if (newStatus === "ACCEPTED") {
    throw conflict("Your shop is suspended, so it cannot accept new orders.");
  }
}
