/**
 * Parent orders (feature F6).
 *
 * A checkout spanning several shops still creates one order per shop (each
 * shop sees and manages only its own, unchanged). With rule "parentOrders" on,
 * those orders also share an order group whose reference ("GK-YYYYMMDD-XXXXXX")
 * the customer uses for the whole purchase. Single-shop orders, and every
 * order placed before this existed, have no group.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { orderGroups, orders, shops, type OrderGroup } from "@/server/db/schema";

export function generateGroupReference(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "0");
  return `GK-${stamp}-${random}`;
}

/** The group for this checkout request, created once (a retried request reuses it). */
export async function getOrCreateOrderGroup(userId: string, requestId: string): Promise<OrderGroup> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [created] = await db
      .insert(orderGroups)
      .values({ userId, requestId, reference: generateGroupReference() })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const existing = await db.query.orderGroups.findFirst({
      where: and(eq(orderGroups.userId, userId), eq(orderGroups.requestId, requestId)),
    });
    if (existing) return existing;
    // Otherwise the random reference collided — try another.
  }
  throw new Error("Could not allocate an order reference.");
}

/** group id → reference, for showing the parent reference next to sub-orders. */
export async function referencesForGroups(groupIds: (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(groupIds.filter((id): id is string => id != null))];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: orderGroups.id, reference: orderGroups.reference }).from(orderGroups).where(inArray(orderGroups.id, ids));
  return new Map(rows.map((r) => [r.id, r.reference]));
}

/** A customer's parent order with its per-shop sub-orders. */
export async function getOrderGroupForUser(userId: string, reference: string) {
  const group = await db.query.orderGroups.findFirst({
    where: and(eq(orderGroups.reference, reference.trim().toUpperCase()), eq(orderGroups.userId, userId)),
  });
  if (!group) throw notFound("Order");
  const subOrders = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalPaise: orders.totalPaise,
      subtotalPaise: orders.subtotalPaise,
      deliveryFeePaise: orders.deliveryFeePaise,
      shopName: shops.name,
      shopSlug: shops.slug,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.orderGroupId, group.id))
    .orderBy(asc(orders.createdAt));
  return {
    reference: group.reference,
    createdAt: group.createdAt,
    totalPaise: subOrders.reduce((n, o) => n + o.totalPaise, 0),
    orders: subOrders,
  };
}
