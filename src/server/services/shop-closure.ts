/**
 * D-69 (owner, 25 Oct 2026): "shop owners can close the shop online ... and
 * if they want to close permanently it should have option".
 *
 * Closing for now is the existing orders_paused switch. Closing permanently
 * sets the shop INACTIVE (lifecycle CLOSED): it leaves search and the
 * storefront and can't take orders; reopening is done by operations (shop
 * approval). Open orders must be delivered or cancelled first, so no
 * customer is left waiting; live subscriptions to the shop are cancelled and
 * their customers told. The shop wallet and payouts are untouched: what is
 * owed is settled as usual.
 */
import { and, count, eq, inArray, isNull, notInArray } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { orders, shops, subscriptions, type Shop, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { OPEN_ORDER_STATUSES } from "./inventory-alerts";
import { cancelSubscription } from "./subscriptions";

const normalizeName = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

export async function closeShopPermanently(
  shopId: string,
  input: { reason: string; confirmName: string },
  actor: { id: string; role: UserRole },
): Promise<Shop> {
  const reason = input.reason.trim();
  if (reason.length < 5) throw validationFailed("Tell us why the shop is closing.", { fields: { reason: "At least 5 characters." } });
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  if (normalizeName(input.confirmName) !== normalizeName(shop.name)) {
    throw validationFailed("Type the shop's name exactly to confirm.", { fields: { confirmName: "Does not match the shop's name." } });
  }

  let closed = shop;
  if (shop.status !== "INACTIVE") {
    const [{ open }] = await db
      .select({ open: count() })
      .from(orders)
      .where(and(eq(orders.shopId, shopId), inArray(orders.status, [...OPEN_ORDER_STATUSES])));
    if (open > 0) {
      throw conflict(`This shop has ${open} open order${open === 1 ? "" : "s"}. Deliver or cancel ${open === 1 ? "it" : "them"} first, then close the shop.`, {
        openOrders: open,
      });
    }
    const [updated] = await db
      .update(shops)
      .set({
        status: "INACTIVE",
        ordersPaused: true,
        closedAt: new Date(),
        closedBy: actor.id,
        closureReason: reason,
        statusActorId: actor.id,
        updatedAt: new Date(),
      })
      // Unchanged since it was read: a suspension or approval in between wins.
      .where(and(eq(shops.id, shopId), eq(shops.status, shop.status)))
      .returning();
    if (!updated) throw conflict("The shop's status just changed. Reload the page and try again.");
    closed = updated;
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_CLOSED,
      entityType: "shop",
      entityId: shopId,
      previousValue: { status: shop.status },
      newValue: { status: "INACTIVE", reason },
    });
  }

  // Customer side (another database on the split layout): after the shop row, and repeatable —
  // calling again on a closed shop finishes any subscription a failure left behind.
  const live = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.shopId, shopId), notInArray(subscriptions.status, ["CANCELLED", "COMPLETED"])));
  for (const s of live) {
    await cancelSubscription(s.id, `${shop.name} has closed on GoKesari.`, actor).catch((error) => {
      console.error("[shop-closure] could not cancel subscription", s.id, error);
    });
  }
  return closed;
}
