/**
 * Shop suspension with a configurable open-order policy.
 *
 * Suspending stops new orders at once (the shop is no longer APPROVED, so it
 * is not purchasable, not serviceable, and cannot accept). Orders already in
 * flight are NOT swept away: each one is judged by its current status against
 * the `suspension` rule —
 *   CANCEL_REFUND  cancel with a full refund and restock (default for orders
 *                  the shop has not yet accepted)
 *   CONTINUE       the shop finishes it (default once the goods are on the road)
 *   REVIEW         held until an operator decides (default while the shop is
 *                  preparing or a rider is assigned)
 * Operations can preview the impact before suspending, and see and resolve it
 * afterwards. The owner is told the reason, when it took effect, what is
 * expected of them and what happened to their open orders.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { RULES } from "@/server/config/rules";
import { db } from "@/server/db";
import {
  orders,
  shopSuspensionOrders,
  shopSuspensions,
  shops,
  type Shop,
  type ShopSuspension,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notifyEvent } from "./notifications";
import { cancelOrder } from "./orders";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

type Action = "CANCEL_REFUND" | "CONTINUE" | "REVIEW";

/** Statuses an order can still be in while the shop has something to do with it. */
const OPEN_STATUSES = ["CONFIRMED", "ACCEPTED", "PREPARING", "READY", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"] as const;

async function policyActions(): Promise<Record<string, Action>> {
  const rule = await getRule("suspension");
  return { ...RULES.suspension.defaults.actions, ...rule.actions } as Record<string, Action>;
}

export interface SuspensionPreview {
  shopId: string;
  shopName: string;
  orders: {
    orderId: string;
    orderNumber: string;
    status: string;
    totalPaise: number;
    plannedAction: Action | "LEFT_ALONE";
  }[];
  counts: { cancelRefund: number; continue: number; review: number; leftAlone: number };
  refundPaise: number;
  subscriptionsActive: number;
}

/** What suspending this shop would do to its open orders, before anything changes. */
export async function previewSuspension(shopId: string): Promise<SuspensionPreview> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  const actions = await policyActions();
  const open = await db
    .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, totalPaise: orders.totalPaise })
    .from(orders)
    .where(and(eq(orders.shopId, shopId), inArray(orders.status, [...OPEN_STATUSES])))
    .orderBy(orders.createdAt);

  const rows = open.map((o) => ({
    orderId: o.id,
    orderNumber: o.orderNumber,
    status: o.status as string,
    totalPaise: o.totalPaise,
    plannedAction: (actions[o.status] ?? "LEFT_ALONE") as Action | "LEFT_ALONE",
  }));
  const count = (a: string) => rows.filter((r) => r.plannedAction === a).length;
  const [subs] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from subscriptions where shop_id = ${shopId} and status = 'ACTIVE'`,
  );
  return {
    shopId,
    shopName: shop.name,
    orders: rows,
    counts: {
      cancelRefund: count("CANCEL_REFUND"),
      continue: count("CONTINUE"),
      review: count("REVIEW"),
      leftAlone: count("LEFT_ALONE"),
    },
    refundPaise: rows.filter((r) => r.plannedAction === "CANCEL_REFUND").reduce((n, r) => n + r.totalPaise, 0),
    subscriptionsActive: Number(subs?.n ?? 0),
  };
}

export interface SuspensionResult {
  shop: Shop;
  suspension: ShopSuspension;
  impact: { cancelled: number; continuing: number; awaitingReview: number; failed: number };
}

export async function suspendShopWithPolicy(
  shopId: string,
  input: { reason: string; expectedAction?: string | null },
  actor: Actor,
): Promise<SuspensionResult> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationFailed("A suspension reason is required.");
  const rule = await getRule("suspension");
  const actions = await policyActions();
  const expectedAction = input.expectedAction?.trim() || rule.defaultExpectedAction;

  const started = await db.transaction(async (tx) => {
    // The APPROVED check is part of the UPDATE, so a concurrent reject or suspend cannot be overwritten or audited twice.
    const [shop] = await tx
      .update(shops)
      .set({ status: "SUSPENDED", updatedAt: new Date() })
      .where(and(eq(shops.id, shopId), eq(shops.status, "APPROVED"), sql`${shops.deletedAt} IS NULL`))
      .returning();
    if (!shop) return null;

    const [suspension] = await tx
      .insert(shopSuspensions)
      .values({ shopId, reason, expectedAction, suspendedBy: actor.id, policy: actions })
      .returning();

    const open = await tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(and(eq(orders.shopId, shopId), inArray(orders.status, [...OPEN_STATUSES])))
      .for("update");
    const planned = open.flatMap((o) => {
      const action = actions[o.status];
      return action ? [{ orderId: o.id, status: o.status as string, action }] : [];
    });
    if (planned.length > 0) {
      await tx.insert(shopSuspensionOrders).values(
        planned.map((p) => ({
          suspensionId: suspension.id,
          orderId: p.orderId,
          statusAtSuspension: p.status,
          plannedAction: p.action,
          // Provisional for cancellations: FAILED until the refund has actually gone through.
          outcome: (p.action === "CONTINUE" ? "CONTINUING" : p.action === "REVIEW" ? "AWAITING_REVIEW" : "FAILED") as
            | "CONTINUING"
            | "AWAITING_REVIEW"
            | "FAILED",
        })),
      );
    }
    return { shop, suspension, planned };
  });

  if (!started) {
    const exists = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true, deletedAt: true } });
    if (!exists || exists.deletedAt) throw notFound("Shop");
    throw conflict("Only an approved shop can be suspended.");
  }

  // Cancellations run after the suspension is committed, one order at a time, so a single problem cannot undo the rest.
  let cancelled = 0;
  let failed = 0;
  for (const p of started.planned.filter((x) => x.action === "CANCEL_REFUND")) {
    try {
      await cancelOrder(p.orderId, actor, `The shop was suspended: ${reason}`);
      await db
        .update(shopSuspensionOrders)
        .set({ outcome: "CANCELLED", note: "Cancelled and refunded when the shop was suspended." })
        .where(and(eq(shopSuspensionOrders.suspensionId, started.suspension.id), eq(shopSuspensionOrders.orderId, p.orderId)));
      cancelled += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message.slice(0, 250) : "Could not cancel.";
      await db
        .update(shopSuspensionOrders)
        .set({ outcome: "FAILED", note: `Automatic cancellation failed: ${message}` })
        .where(and(eq(shopSuspensionOrders.suspensionId, started.suspension.id), eq(shopSuspensionOrders.orderId, p.orderId)));
    }
  }
  const impact = {
    cancelled,
    continuing: started.planned.filter((x) => x.action === "CONTINUE").length,
    awaitingReview: started.planned.filter((x) => x.action === "REVIEW").length,
    failed,
  };
  await db.update(shopSuspensions).set({ impact }).where(eq(shopSuspensions.id, started.suspension.id));

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_SUSPENDED,
    entityType: "shop",
    entityId: shopId,
    previousValue: { status: "APPROVED" },
    newValue: { status: "SUSPENDED", reason, expectedAction, impact, suspensionId: started.suspension.id },
  });

  const parts = [
    cancelled ? `${cancelled} unaccepted order${cancelled === 1 ? " was" : "s were"} cancelled and refunded.` : "",
    impact.continuing ? `${impact.continuing} order${impact.continuing === 1 ? " is" : "s are"} already on the road — please let ${impact.continuing === 1 ? "it" : "them"} complete.` : "",
    impact.awaitingReview ? `${impact.awaitingReview} order${impact.awaitingReview === 1 ? " is" : "s are"} being reviewed by our team — do not continue ${impact.awaitingReview === 1 ? "it" : "them"} until we confirm.` : "",
    failed ? `${failed} order${failed === 1 ? "" : "s"} need our team's attention.` : "",
  ].filter(Boolean);
  await notifyEvent(
    NOTIFICATION_TYPES.SHOP_SUSPENDED,
    started.shop.ownerId,
    {
      shopName: started.shop.name,
      effectiveAt: started.suspension.effectiveAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }),
      reason,
      impact: parts.length ? parts.join(" ") : "You had no open orders.",
      expectedAction,
    },
    { actionUrl: "/shop", dedupeKey: `shop-suspended:${started.suspension.id}` },
  );

  const [suspension] = await db.select().from(shopSuspensions).where(eq(shopSuspensions.id, started.suspension.id));
  return { shop: started.shop, suspension, impact };
}

/** Lifts the suspension: the shop is approved again and orders held for review go back to it. */
export async function reactivateShop(shopId: string, note: string, actor: Actor): Promise<Shop> {
  const trimmed = note.trim();
  if (trimmed.length < 3) throw validationFailed("A reinstatement note is required.");

  const shop = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(shops)
      .set({ status: "APPROVED", updatedAt: new Date() })
      .where(and(eq(shops.id, shopId), eq(shops.status, "SUSPENDED"), sql`${shops.deletedAt} IS NULL`))
      .returning();
    if (!row) return null;
    const [active] = await tx
      .update(shopSuspensions)
      .set({ status: "LIFTED", liftedAt: new Date(), liftedBy: actor.id, liftNote: trimmed })
      .where(and(eq(shopSuspensions.shopId, shopId), eq(shopSuspensions.status, "ACTIVE")))
      .returning();
    if (active) {
      await tx
        .update(shopSuspensionOrders)
        .set({ outcome: "CONTINUING", note: "Returned to the shop when the suspension was lifted.", resolvedBy: actor.id, resolvedAt: new Date() })
        .where(and(eq(shopSuspensionOrders.suspensionId, active.id), eq(shopSuspensionOrders.outcome, "AWAITING_REVIEW")));
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_REACTIVATED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { status: "SUSPENDED" },
        newValue: { status: "APPROVED", note: trimmed },
      },
      tx,
    );
    return row;
  });
  if (!shop) {
    const exists = await db.query.shops.findFirst({ where: eq(shops.id, shopId), columns: { id: true } });
    if (!exists) throw notFound("Shop");
    throw conflict("Only a suspended shop can be reinstated.");
  }
  await notifyEvent(NOTIFICATION_TYPES.SHOP_REACTIVATED, shop.ownerId, { shopName: shop.name }, { actionUrl: "/shop" });
  return shop;
}

/** Operations decides an order the policy held for review (or one whose automatic cancel failed). */
export async function resolveSuspendedOrder(
  orderId: string,
  decision: "CANCEL_REFUND" | "CONTINUE",
  note: string | null,
  actor: Actor,
): Promise<void> {
  const [row] = await db
    .select({ rec: shopSuspensionOrders, shopId: shopSuspensions.shopId })
    .from(shopSuspensionOrders)
    .innerJoin(shopSuspensions, eq(shopSuspensionOrders.suspensionId, shopSuspensions.id))
    .where(
      and(
        eq(shopSuspensionOrders.orderId, orderId),
        eq(shopSuspensions.status, "ACTIVE"),
        inArray(shopSuspensionOrders.outcome, ["AWAITING_REVIEW", "FAILED"]),
      ),
    );
  if (!row) throw conflict("This order is not waiting for a suspension decision.");

  if (decision === "CANCEL_REFUND") {
    await cancelOrder(orderId, actor, `The shop was suspended${note ? `: ${note}` : ""}`);
  }
  await db
    .update(shopSuspensionOrders)
    .set({
      outcome: decision === "CANCEL_REFUND" ? "CANCELLED" : "CONTINUING",
      note: note?.trim() || null,
      resolvedBy: actor.id,
      resolvedAt: new Date(),
    })
    .where(eq(shopSuspensionOrders.id, row.rec.id));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_SUSPENSION_ORDER_RESOLVED,
    entityType: "order",
    entityId: orderId,
    newValue: { decision, note: note ?? null },
  });
}

/* ----------------------------------------------------------- reading */

export async function getActiveSuspension(shopId: string): Promise<ShopSuspension | null> {
  const [row] = await db
    .select()
    .from(shopSuspensions)
    .where(and(eq(shopSuspensions.shopId, shopId), eq(shopSuspensions.status, "ACTIVE")))
    .orderBy(desc(shopSuspensions.createdAt))
    .limit(1);
  return row ?? null;
}

export interface SuspensionOverview {
  suspension: ShopSuspension;
  shopName: string;
  orders: { orderId: string; orderNumber: string; statusNow: string; statusAtSuspension: string; plannedAction: string; outcome: string; note: string | null }[];
}

/** Active suspensions with what happened to each order — the admin's "after" view. */
export async function listActiveSuspensions(): Promise<SuspensionOverview[]> {
  const active = await db
    .select({ suspension: shopSuspensions, shopName: shops.name })
    .from(shopSuspensions)
    .innerJoin(shops, eq(shopSuspensions.shopId, shops.id))
    .where(eq(shopSuspensions.status, "ACTIVE"))
    .orderBy(desc(shopSuspensions.createdAt));
  if (active.length === 0) return [];
  const recs = await db
    .select({
      suspensionId: shopSuspensionOrders.suspensionId,
      orderId: shopSuspensionOrders.orderId,
      orderNumber: orders.orderNumber,
      statusNow: orders.status,
      statusAtSuspension: shopSuspensionOrders.statusAtSuspension,
      plannedAction: shopSuspensionOrders.plannedAction,
      outcome: shopSuspensionOrders.outcome,
      note: shopSuspensionOrders.note,
    })
    .from(shopSuspensionOrders)
    .innerJoin(orders, eq(shopSuspensionOrders.orderId, orders.id))
    .where(inArray(shopSuspensionOrders.suspensionId, active.map((a) => a.suspension.id)));
  return active.map((a) => ({
    suspension: a.suspension,
    shopName: a.shopName,
    orders: recs.filter((r) => r.suspensionId === a.suspension.id).map(({ suspensionId: _s, ...rest }) => {
      void _s;
      return rest;
    }),
  }));
}
