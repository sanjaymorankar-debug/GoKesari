/**
 * NEW-007 shop acceptance timeout (rule shopAcceptance).
 *
 * A direct order gets an accept-by time at checkout: now + acceptMinutes, or
 * — for an order placed while the shop is closed — the shop's opening time +
 * acceptMinutes. The minute sweep (POST /api/cron/shop-acceptance)
 *   1. reminds the shop once the set share of the time has passed, and
 *   2. cancels an order still CONFIRMED after its accept-by time through the
 *      existing cancel path (full refund, restock, customer told), as the
 *      system. The cancel re-checks the status under the order's row lock, so
 *      a shop accepting at the same moment always wins.
 * Orders an operator is holding for a suspended shop's review are left alone.
 * Subscription orders are never stamped (they are generated for the day and
 * accepted on the shop's own schedule).
 */
import { and, count, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { AppError } from "@/lib/errors";
import { db } from "@/server/db";
import { orders, shopSlaEvents, shops } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { cancelOrder } from "./orders";
import { getRule } from "./settings";
import { suspensionRecordFor } from "./shop-suspension-guard";

export const ACCEPT_TIMEOUT_REASON = "The shop did not accept the order in time";

/** The accept-by time for an order confirmed now; null when the rule is off. */
export async function acceptByFor(now: Date, expectedOpenAt: Date | null): Promise<Date | null> {
  const rule = await getRule("shopAcceptance");
  if (!rule.enabled) return null;
  const from = expectedOpenAt && expectedOpenAt.getTime() > now.getTime() ? expectedOpenAt : now;
  return new Date(from.getTime() + rule.acceptMinutes * 60_000);
}

export interface AcceptanceSweepResult {
  reminded: number;
  cancelled: number;
  skipped: number;
}

export async function runShopAcceptanceSweep(now: Date = new Date()): Promise<AcceptanceSweepResult> {
  const result: AcceptanceSweepResult = { reminded: 0, cancelled: 0, skipped: 0 };
  const rule = await getRule("shopAcceptance");
  if (!rule.enabled) return result;
  const windowMs = rule.acceptMinutes * 60_000;

  // 1. Reminders, once, after reminderAtFraction of the window.
  const remindFrom = sql`${orders.acceptByAt} - make_interval(secs => ${(windowMs * (1 - rule.reminderAtFraction)) / 1000})`;
  const due = await db
    .select({ order: orders, ownerId: shops.ownerId })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(orders.status, "CONFIRMED"),
        eq(orders.source, "DIRECT"),
        isNotNull(orders.acceptByAt),
        isNull(orders.acceptReminderSentAt),
        sql`${now.toISOString()}::timestamptz >= ${remindFrom}`,
        sql`${now.toISOString()}::timestamptz < ${orders.acceptByAt}`,
      ),
    )
    .limit(500);
  for (const { order, ownerId } of due) {
    const [marked] = await db
      .update(orders)
      .set({ acceptReminderSentAt: now })
      .where(and(eq(orders.id, order.id), isNull(orders.acceptReminderSentAt)))
      .returning({ id: orders.id });
    if (!marked) continue;
    const minutesLeft = Math.max(1, Math.ceil((order.acceptByAt!.getTime() - now.getTime()) / 60_000));
    await notify({
      userId: ownerId,
      type: NOTIFICATION_TYPES.SHOP_ACCEPT_REMINDER,
      title: "Accept the new order",
      body: `Order ${order.orderNumber} is cancelled automatically unless you accept it in the next ${minutesLeft} min.`,
      actionUrl: "/shop/orders",
      dedupeKey: `accept-reminder:${order.id}`,
    });
    await db.insert(shopSlaEvents).values({ shopId: order.shopId, orderId: order.id, kind: "REMINDER" }).onConflictDoNothing();
    result.reminded += 1;
  }

  // 2. Missed: cancel with a full refund.
  const expired = await db
    .select({ order: orders, ownerId: shops.ownerId })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(
      and(
        eq(orders.status, "CONFIRMED"),
        eq(orders.source, "DIRECT"),
        isNotNull(orders.acceptByAt),
        lt(orders.acceptByAt, now),
      ),
    )
    .limit(200);
  for (const { order, ownerId } of expired) {
    const held = await suspensionRecordFor(db, order.shopId, order.id);
    if (held.record?.outcome === "AWAITING_REVIEW") {
      result.skipped += 1;
      continue;
    }
    try {
      await cancelOrder(order.id, null, ACCEPT_TIMEOUT_REASON, { onlyIfStatus: "CONFIRMED" });
    } catch (error) {
      // Accepted (or otherwise moved on) at the same moment: nothing to do.
      if (error instanceof AppError && (error.code === "CONFLICT" || error.code === "INVALID_STATE_TRANSITION")) {
        result.skipped += 1;
        continue;
      }
      throw error;
    }
    await db.insert(shopSlaEvents).values({ shopId: order.shopId, orderId: order.id, kind: "MISSED" }).onConflictDoNothing();
    await recordAudit({
      actorId: null,
      action: AUDIT_ACTIONS.ORDER_AUTO_CANCELLED,
      entityType: "order",
      entityId: order.id,
      newValue: { reason: ACCEPT_TIMEOUT_REASON, acceptByAt: order.acceptByAt },
    });
    await notify({
      userId: ownerId,
      type: NOTIFICATION_TYPES.SHOP_ORDER_TIMED_OUT,
      title: "Order cancelled — not accepted in time",
      body: `Order ${order.orderNumber} was cancelled and the customer refunded because it was not accepted by ${order.acceptByAt!.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}.`,
      actionUrl: "/shop/orders",
      dedupeKey: `accept-missed:${order.id}`,
    });
    result.cancelled += 1;
  }
  return result;
}

/** Orders a shop let time out in the last 30 days (shown on the shop dashboard). */
export async function missedAcceptances30d(shopId: string, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(shopSlaEvents)
    .where(
      and(
        eq(shopSlaEvents.shopId, shopId),
        eq(shopSlaEvents.kind, "MISSED"),
        gte(shopSlaEvents.createdAt, new Date(now.getTime() - 30 * 86_400_000)),
      ),
    );
  return row?.n ?? 0;
}
