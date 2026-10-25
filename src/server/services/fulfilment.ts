/**
 * Shop fulfilment (Vertical Slice 3 — GS-034/035/036, WF-002):
 *
 *   CONFIRMED (paid, shop pending) → accept / reject
 *   ACCEPTED → PREPARING: pick each line; if a line is unavailable the shop
 *     proposes a substitute (customer approves/rejects) or removes it
 *   → READY (packed) → rider dispatch (delivery-assignment.ts)
 *
 * Built on the existing order, order-item, stock and wallet structures — no
 * parallel order system. Money rules:
 *  - a removed line is refunded in full, the way the order was paid
 *    (TC-PAY-029): to the wallet for a wallet order, to the original payment
 *    method (or the wallet, by rule) for an online order — sent to the gateway
 *    after commit — and nothing for cash on delivery (less is collected);
 *  - a substitute is charged at the lower of its own price and the original
 *    line (the shop absorbs any increase — the customer never pays more than
 *    they agreed to at checkout); a cheaper substitute refunds the difference;
 *    the original product goes back to stock and the substitute leaves it;
 *  - every refund reduces order.subtotalPaise/totalPaise and adds to
 *    refundedPaise, so a later cancellation refunds only what is still held.
 * If every line ends up removed, the order is cancelled (refunding the rest).
 */
import { and, eq } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { lineTotalPaise } from "@/lib/money";
import { milliToStockUnits, quantityToMilli } from "@/lib/stock-quantity";
import { db, type DbClient } from "@/server/db";
import {
  orderItems,
  orders,
  products,
  shopProducts,
  shops,
  type Order,
  type OrderItemFulfilment,
  type OrderStatus,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { consumeOnlineStock, loadPurchasableShopProduct, restockOnline } from "./catalogue";
import { dispatchReadyOrder } from "./delivery-assignment";
import { assertFulfilmentChosen } from "./fulfilment-guards";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { cancelOrder, updateOrderStatus } from "./orders";
import { refundOrderPart, sendRequestedOriginalRefunds, type PartRefundRoute } from "@/server/aftercare/refunds";

interface Actor {
  id: string;
  role: UserRole;
}

/** Statuses in which a shop may work on individual lines. */
const WORKING_STATUSES: readonly OrderStatus[] = ["ACCEPTED", "PREPARING"];

/* ------------------------------------------------------ order-level */

/** Shop confirms it will fulfil the order (CONFIRMED → ACCEPTED). */
export async function acceptOrder(orderId: string, actor: Actor): Promise<Order> {
  return updateOrderStatus(orderId, "ACCEPTED", actor, "Accepted by shop");
}

/** Shop declines the whole order — a shop-privileged cancel with a full refund and restock. */
export async function rejectOrder(orderId: string, actor: Actor, reason: string): Promise<Order> {
  const trimmed = reason.trim();
  if (!trimmed) throw validationFailed("Tell the customer why the order is being rejected.");
  return cancelOrder(orderId, actor, `Rejected by shop: ${trimmed}`);
}

/** ACCEPTED → PREPARING (picking starts). */
export async function startPicking(orderId: string, actor: Actor): Promise<Order> {
  return updateOrderStatus(orderId, "PREPARING", actor, "Picking started");
}

/**
 * Packs the order and marks it READY. Lines still PENDING are taken as
 * picked (the shop is confirming the packed bag), which keeps the existing
 * one-click "Mark ready" working; a line awaiting the customer's
 * substitution decision blocks it. Then asks for a rider when the shop
 * delivers through the platform.
 */
export async function markOrderReady(
  orderId: string,
  actor: Actor,
  /**
   * Fulfilment options (docs/four-features-2026-10): saves the shop's choice
   * (pickup / own delivery / GoKesari partner and a time) in the same
   * transaction, before the order becomes READY.
   */
  options: { beforeReady?: (tx: DbClient, order: Order) => Promise<void> } = {},
): Promise<Order> {
  const ready = await db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (order.status !== "PREPARING") {
      throw conflict("Start preparing the order before marking it ready.");
    }
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    if (items.some((i) => i.fulfilmentStatus === "SUBSTITUTION_PROPOSED")) {
      throw conflict("Waiting for the customer to approve or reject a substitution.");
    }
    if (items.every((i) => i.fulfilmentStatus === "REMOVED")) {
      throw conflict("Every item was removed — reject the order instead.");
    }
    if (options.beforeReady) await options.beforeReady(tx, order);
    else await assertFulfilmentChosen(tx, orderId);
    await tx
      .update(orderItems)
      .set({ fulfilmentStatus: "PICKED", fulfilmentUpdatedAt: new Date() })
      .where(and(eq(orderItems.orderId, orderId), eq(orderItems.fulfilmentStatus, "PENDING")));
    return updateOrderStatus(orderId, "READY", actor, "Packed and ready", tx);
  });

  // After commit: a failed rider search must never undo the READY state.
  await dispatchReadyOrder(orderId, actor).catch((error) => {
    console.error("[fulfilment] dispatch after READY failed", orderId, error);
  });
  return ready;
}

/* ------------------------------------------------------- line-level */

export async function pickItem(orderId: string, itemId: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await lockOrderInWork(tx, orderId, actor);
    const item = await loadItem(tx, orderId, itemId);
    if (item.fulfilmentStatus !== "PENDING") {
      throw conflict("This item has already been handled.");
    }
    await setItemStatus(tx, item.id, "PICKED", null);
    await auditItem(tx, actor, order, item.id, item.fulfilmentStatus, "PICKED");
  });
}

/**
 * Offers a replacement from the same shop for a line it cannot supply. The
 * substitute must be buyable online now in the same number of units.
 */
export async function proposeSubstitution(
  orderId: string,
  itemId: string,
  substituteShopProductId: string,
  actor: Actor,
  note?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const order = await lockOrderInWork(tx, orderId, actor);
    const item = await loadItem(tx, orderId, itemId);
    if (item.fulfilmentStatus !== "PENDING" && item.fulfilmentStatus !== "PICKED") {
      throw conflict("A substitute can only be proposed for an item still being picked.");
    }
    if (substituteShopProductId === item.shopProductId) {
      throw validationFailed("Choose a different product as the substitute.");
    }

    const units = await stockUnits(tx, item.shopProductId, item.quantityMilli);
    let substitute = await loadPurchasableShopProduct(substituteShopProductId, units, tx);
    if (substitute.shopId !== order.shopId) {
      throw validationFailed("The substitute must come from the same shop.");
    }
    // D-95: a packaged substitute for part of a loose unit (250 g) is one whole pack.
    const substituteUnits = substitute.product.kind === "LOOSE" ? units : Math.max(1, Math.round(units));
    if (substituteUnits > units) substitute = await loadPurchasableShopProduct(substituteShopProductId, substituteUnits, tx);
    const substituteQuantityMilli = quantityToMilli(substituteUnits, substitute.product.unitSizeMilli);
    const substituteLineTotal = Math.min(
      lineTotalPaise(substitute.unitPricePaise, substituteQuantityMilli),
      item.lineTotalPaise,
    );

    await tx
      .update(orderItems)
      .set({
        fulfilmentStatus: "SUBSTITUTION_PROPOSED",
        substituteShopProductId,
        substituteNameSnapshot: substitute.product.name,
        substituteUnitSnapshot: substitute.product.unit,
        substituteQuantityMilli,
        substituteLineTotalPaise: substituteLineTotal,
        substituteMrpPaise: substitute.product.mrpPaise ?? null,
        fulfilmentNote: note?.trim() || null,
        fulfilmentUpdatedAt: new Date(),
      })
      .where(eq(orderItems.id, item.id));
    await auditItem(tx, actor, order, item.id, item.fulfilmentStatus, "SUBSTITUTION_PROPOSED", {
      substituteShopProductId,
      substituteLineTotal,
    });

    await notify(
      {
        userId: order.userId,
        type: NOTIFICATION_TYPES.ORDER_SUBSTITUTION_PROPOSED,
        title: "Substitute proposed",
        body: `${item.productNameSnapshot} is unavailable for order ${order.orderNumber}. The shop suggests ${substitute.product.name} — approve or reject it in My Orders.`,
        actionUrl: "/orders",
      },
      tx,
    );
  });
}

/** Shop drops a line it cannot supply (no substitute) — refunded the way the order was paid. */
export async function removeItem(
  orderId: string,
  itemId: string,
  actor: Actor,
  reason: string,
): Promise<void> {
  const { allRemoved, route } = await db.transaction(async (tx) => {
    const order = await lockOrderInWork(tx, orderId, actor);
    const item = await loadItem(tx, orderId, itemId);
    if (item.fulfilmentStatus === "REMOVED" || item.fulfilmentStatus === "SUBSTITUTED") {
      throw conflict("This item has already been handled.");
    }
    await setItemStatus(tx, item.id, "REMOVED", reason.trim() || "Unavailable");
    const route = await refundLine(tx, order, item.lineTotalPaise, `line:${item.id}`, actor,
      `Refund: ${item.productNameSnapshot} unavailable (order ${order.orderNumber})`);
    await auditItem(tx, actor, order, item.id, item.fulfilmentStatus, "REMOVED", { reason, refundTo: route });
    await notify(
      {
        userId: order.userId,
        type: NOTIFICATION_TYPES.ORDER_ITEM_REMOVED,
        title: "Item unavailable",
        body: `${item.productNameSnapshot} was removed from order ${order.orderNumber}${REMOVED_LINE_MONEY[route]}`,
        actionUrl: "/orders",
      },
      tx,
    );
    return { allRemoved: await everyLineRemoved(tx, orderId), route };
  });
  await sendGatewayRefundsAfterCommit(orderId, route);
  if (allRemoved) await cancelOrder(orderId, actor, "All items were unavailable");
}

/** How the customer is told where a removed line's money went. */
const REMOVED_LINE_MONEY: Record<PartRefundRoute, string> = {
  WALLET: " and refunded to your wallet.",
  ORIGINAL: " and is being refunded to your original payment method.",
  NONE: " — nothing is charged for it.",
};

/**
 * TC-PAY-029: a line refund to the original payment method is only recorded
 * inside the transaction; it goes to the gateway once that has committed
 * (never for a change that could still roll back). Idempotent; the aftercare
 * and payments jobs retry it if this attempt fails.
 */
async function sendGatewayRefundsAfterCommit(orderId: string, route: PartRefundRoute): Promise<void> {
  if (route !== "ORIGINAL") return;
  await sendRequestedOriginalRefunds(orderId).catch((error) =>
    console.error("[fulfilment] line refund send failed for order", orderId, error),
  );
}

/**
 * Customer decision on a proposed substitute. Approve: the substitute is
 * taken from stock and any price difference refunded. Reject: the line is
 * removed and refunded.
 */
export async function decideSubstitution(
  orderId: string,
  itemId: string,
  customer: Actor,
  approve: boolean,
): Promise<void> {
  const { allRemoved, route } = await db.transaction(async (tx): Promise<{ allRemoved: boolean; route: PartRefundRoute }> => {
    const order = await lockOrder(tx, orderId);
    if (order.userId !== customer.id) throw notFound("Order");
    if (!WORKING_STATUSES.includes(order.status)) {
      throw conflict("This order can no longer be changed.");
    }
    const item = await loadItem(tx, orderId, itemId);
    if (item.fulfilmentStatus !== "SUBSTITUTION_PROPOSED" || !item.substituteShopProductId) {
      throw conflict("There is no substitution waiting for your decision.");
    }

    if (approve) {
      const units = await stockUnits(tx, item.substituteShopProductId, item.substituteQuantityMilli ?? 0);
      await consumeOnlineStock(
        item.substituteShopProductId,
        units,
        `Substitute for order ${order.orderNumber}`,
        tx,
        order.id,
      );
      // TC-SPI-010: the original product was taken from stock at checkout but is
      // not sold — it goes back (a SALE_RETURN of this order in the stock
      // ledger), so only the substitute leaves stock.
      const originalUnits = await trackedUnits(tx, item.shopProductId, item.quantityMilli);
      if (originalUnits > 0) {
        await restockOnline(
          item.shopProductId,
          originalUnits,
          `Order ${order.orderNumber}: ${item.productNameSnapshot} substituted by ${item.substituteNameSnapshot ?? "another product"}`,
          customer.id,
          tx,
          order.id,
        );
      }
      await setItemStatus(tx, item.id, "SUBSTITUTED", item.fulfilmentNote);
      const difference = item.lineTotalPaise - (item.substituteLineTotalPaise ?? item.lineTotalPaise);
      const route =
        difference > 0
          ? await refundLine(tx, order, difference, `substitute:${item.id}`, customer,
              `Price difference: ${item.substituteNameSnapshot} for ${item.productNameSnapshot} (order ${order.orderNumber})`)
          : "NONE";
      await auditItem(tx, customer, order, item.id, "SUBSTITUTION_PROPOSED", "SUBSTITUTED", { difference, refundTo: route });
      return { allRemoved: false, route };
    }

    await setItemStatus(tx, item.id, "REMOVED", "Customer rejected the substitute");
    const route = await refundLine(tx, order, item.lineTotalPaise, `line:${item.id}`, customer,
      `Refund: ${item.productNameSnapshot} unavailable, substitute declined (order ${order.orderNumber})`);
    await auditItem(tx, customer, order, item.id, "SUBSTITUTION_PROPOSED", "REMOVED", { refundTo: route });
    return { allRemoved: await everyLineRemoved(tx, orderId), route };
  });
  await sendGatewayRefundsAfterCommit(orderId, route);
  if (allRemoved) await cancelOrder(orderId, customer, "All items were unavailable");

  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  const shop = order ? await db.query.shops.findFirst({ where: eq(shops.id, order.shopId) }) : null;
  if (order && shop) {
    await notify({
      userId: shop.ownerId,
      type: NOTIFICATION_TYPES.ORDER_SUBSTITUTION_PROPOSED,
      title: approve ? "Substitute approved" : "Substitute rejected",
      body: `Order ${order.orderNumber}: the customer ${approve ? "approved" : "rejected"} the substitute.`,
      actionUrl: "/shop/orders",
    });
  }
}

/* ---------------------------------------------------------- helpers */

async function lockOrder(tx: DbClient, orderId: string): Promise<Order> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
  if (!order) throw notFound("Order");
  return order;
}

/** Locks the order and moves an ACCEPTED order into PREPARING on the first line action. */
async function lockOrderInWork(tx: DbClient, orderId: string, actor: Actor): Promise<Order> {
  const order = await lockOrder(tx, orderId);
  if (!WORKING_STATUSES.includes(order.status)) {
    throw conflict(
      order.status === "CONFIRMED"
        ? "Accept the order before working on its items."
        : "This order's items can no longer be changed.",
    );
  }
  if (order.status === "ACCEPTED") {
    return updateOrderStatus(orderId, "PREPARING", actor, "Picking started", tx);
  }
  return order;
}

async function loadItem(tx: DbClient, orderId: string, itemId: string) {
  const [item] = await tx
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.id, itemId), eq(orderItems.orderId, orderId)));
  if (!item) throw notFound("Order item");
  return item;
}

async function setItemStatus(
  tx: DbClient,
  itemId: string,
  status: OrderItemFulfilment,
  note: string | null,
): Promise<void> {
  await tx
    .update(orderItems)
    .set({ fulfilmentStatus: status, fulfilmentNote: note, fulfilmentUpdatedAt: new Date() })
    .where(eq(orderItems.id, itemId));
}

/** Whole sellable units a line represents (quantityMilli / the product's unit size). */
/** The sellable units a line's quantity takes from stock: at least one whole unit, or exactly for a loose good (D-95). */
async function stockUnits(tx: DbClient, shopProductId: string, quantityMilli: number): Promise<number> {
  const [row] = await tx
    .select({ unitSizeMilli: products.unitSizeMilli, kind: products.kind })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .where(eq(shopProducts.id, shopProductId));
  if (!row) throw notFound("Product");
  if (row.kind === "LOOSE") return Math.max(0.001, milliToStockUnits(quantityMilli, row.unitSizeMilli, "LOOSE"));
  return Math.max(1, Math.round(quantityMilli / row.unitSizeMilli));
}

/**
 * Refunds a removed line / substitute difference and takes it off the order's
 * totals. TC-PAY-029: the money goes back the way the order was paid (wallet
 * debit, online payment, or nothing for unpaid cash on delivery) — before, an
 * online-paid order answered 404 "Original wallet debit … not found".
 */
/** Units checkout took from stock for a line (0 when the listing does not track stock). */
async function trackedUnits(tx: DbClient, shopProductId: string, quantityMilli: number): Promise<number> {
  const [row] = await tx
    .select({ trackInventory: shopProducts.trackInventory })
    .from(shopProducts)
    .where(eq(shopProducts.id, shopProductId));
  if (!row?.trackInventory) return 0;
  return stockUnits(tx, shopProductId, quantityMilli);
}

async function refundLine(
  tx: DbClient,
  order: Order,
  amountPaise: number,
  keySuffix: string,
  actor: Actor,
  description: string,
): Promise<PartRefundRoute> {
  if (amountPaise <= 0) return "NONE";
  // F7: a coupon-discounted order never refunds more goods than were paid for —
  // the discount is used up by the last lines refunded.
  if (order.discountPaise > 0) {
    const [latest] = await tx.select().from(orders).where(eq(orders.id, order.id));
    amountPaise = Math.min(amountPaise, Math.max(0, latest.totalPaise - latest.deliveryFeePaise - latest.taxPaise));
    if (amountPaise <= 0) return "NONE";
  }
  const { route } = await refundOrderPart(tx, order, { amountPaise, key: keySuffix, description, actor });
  // Re-read inside the lock so two line refunds in a row both apply.
  const [current] = await tx.select().from(orders).where(eq(orders.id, order.id));
  await tx
    .update(orders)
    .set({
      subtotalPaise: Math.max(0, current.subtotalPaise - amountPaise),
      totalPaise: Math.max(0, current.totalPaise - amountPaise),
      refundedPaise: current.refundedPaise + amountPaise,
      updatedAt: new Date(),
    })
    .where(eq(orders.id, order.id));
  return route;
}

async function everyLineRemoved(tx: DbClient, orderId: string): Promise<boolean> {
  const items = await tx
    .select({ status: orderItems.fulfilmentStatus })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));
  return items.length > 0 && items.every((i) => i.status === "REMOVED");
}

async function auditItem(
  tx: DbClient,
  actor: Actor,
  order: Order,
  itemId: string,
  from: OrderItemFulfilment,
  to: OrderItemFulfilment,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.ORDER_ITEM_FULFILMENT_CHANGED,
      entityType: "order_item",
      entityId: itemId,
      previousValue: { fulfilmentStatus: from },
      newValue: { fulfilmentStatus: to, orderId: order.id, ...extra },
    },
    tx,
  );
}
