/**
 * Orders paid online at a payment gateway (batch-2026-10 WS-A, F1.7.3 / F1.8.4,
 * GS-028, NEW-007). Rule `onlinePayments` (default OFF).
 *
 *   checkout(ONLINE) → order(s) PENDING, stock held, cart cleared
 *        └→ ONE payment intent for all of them (key derived from the checkout key,
 *           so a retry / double click returns the same intent — never two payments)
 *   CAPTURED          → every order CONFIRMED ("placed / paid", paidAt set) with the
 *                       usual order.placed event and the customer + shop notices
 *   FAILED / EXPIRED  → orders PAYMENT_FAILED, stock released; "retry payment"
 *                       re-holds the stock and opens a new attempt for the same orders
 *
 * Wallet and cash-on-delivery checkout are untouched: this module is only
 * reached when the customer chose "Pay online".
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatShopTime } from "@/lib/shop-hours";
import { db, type DbClient } from "@/server/db";
import {
  orderGroups,
  orderItems,
  orderStatusHistory,
  orders,
  paymentIntents,
  products,
  shopProducts,
  shops,
  users,
  type Order,
  type OrderStatus,
  type PaymentIntentRow,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { consumeOnlineStock, restockOnline } from "@/server/services/catalogue";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { checkout, type CheckoutInput, type CheckoutResult } from "@/server/services/orders";
import { postRetainedDeliveryFee } from "@/server/services/finance";
import { getRule } from "@/server/services/settings";
import { acceptByFor } from "@/server/services/shop-acceptance";
import { assertGatewayUsable, getPaymentGateway } from "./gateway/registry";
import { GatewayNotConfiguredError } from "./gateway/types";
import { toIntentRef } from "./intent-store";
import {
  createPaymentIntent,
  findCapturedIntent,
  isLive,
  isPaid,
  listIntentsFor,
  redirectUrlOf,
  refundPaymentIntent,
  type PaymentIntentRef,
  type PaymentPurpose,
} from "./intents";

/** Statuses an online order waits in until its payment is captured. */
const AWAITING_PAYMENT: readonly OrderStatus[] = ["PENDING", "PAYMENT_FAILED"];

export const ONLINE_PAYMENTS_OFF = "Online payment is not available. Please pay from your wallet or choose cash on delivery.";

export interface OnlinePaymentView {
  intentId: string;
  status: PaymentIntentRow["status"];
  amountPaise: number;
  /** Where to send the browser to pay (hosted page / our SDK page); null when nothing is left to pay. */
  redirectUrl: string | null;
  alreadyPaid: boolean;
}

export interface OnlineCheckoutResult extends CheckoutResult {
  payment: OnlinePaymentView | null;
}

/* ------------------------------------------------------------ helpers */

async function assertOnlinePaymentsOn(): Promise<void> {
  if (!(await getRule("onlinePayments")).enabled) throw conflict(ONLINE_PAYMENTS_OFF);
  try {
    await assertGatewayUsable(getPaymentGateway());
  } catch (error) {
    if (error instanceof GatewayNotConfiguredError) throw conflict(ONLINE_PAYMENTS_OFF);
    throw error;
  }
}

/** The orders an order-purpose intent pays for (ORDER: one; ORDER_GROUP: the group's online orders). */
async function ordersForIntent(intent: Pick<PaymentIntentRef, "purpose" | "referenceId">, tx: DbClient, lock: boolean): Promise<Order[]> {
  const where =
    intent.purpose === "ORDER"
      ? eq(orders.id, intent.referenceId)
      : and(eq(orders.orderGroupId, intent.referenceId), eq(orders.paymentMethod, "ONLINE"));
  const query = tx.select().from(orders).where(where).orderBy(orders.createdAt);
  return lock ? query.for("update") : query;
}

async function orderItemsInUnits(orderId: string, tx: DbClient) {
  return tx
    .select({
      shopProductId: orderItems.shopProductId,
      quantityMilli: orderItems.quantityMilli,
      unitSizeMilli: products.unitSizeMilli,
      trackInventory: shopProducts.trackInventory,
    })
    .from(orderItems)
    .innerJoin(shopProducts, eq(shopProducts.id, orderItems.shopProductId))
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(eq(orderItems.orderId, orderId));
}

/** Gives back the stock an unpaid online order held (same helper and ledger wording as a cancellation). */
async function releaseStock(order: Order, tx: DbClient): Promise<void> {
  for (const line of await orderItemsInUnits(order.id, tx)) {
    const units = Math.round(line.quantityMilli / (line.unitSizeMilli || 1000));
    if (units > 0 && line.trackInventory) {
      // "Order <n> cancelled" is the wording the stock ledger links back to the order (0078).
      await restockOnline(line.shopProductId, units, `Order ${order.orderNumber} cancelled`, null, tx);
    }
  }
}

/** Takes the stock again for a payment retry; throws OUT_OF_STOCK if it has gone meanwhile. */
async function holdStock(order: Order, tx: DbClient): Promise<void> {
  for (const line of await orderItemsInUnits(order.id, tx)) {
    const units = Math.round(line.quantityMilli / (line.unitSizeMilli || 1000));
    if (units > 0) await consumeOnlineStock(line.shopProductId, units, "Online order (payment retry)", tx, order.id);
  }
}

async function customerOf(userId: string) {
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, phone: users.phoneE164 })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw notFound("Customer");
  return user;
}

/* ------------------------------------------------------- start / retry */

/**
 * Checkout with "Pay online": the orders are created exactly as for the
 * wallet (prices, stock, slots, coupons, closed-shop checks — the same
 * checkout()), but left PENDING, and one payment intent is opened for them.
 */
export async function startOnlineCheckout(input: Omit<CheckoutInput, "paymentMethod">): Promise<OnlineCheckoutResult> {
  await assertOnlinePaymentsOn();
  if ((input.orderType ?? "PERSONAL") !== "PERSONAL") throw validationFailed("Business orders are paid from the wallet.");
  const result = await checkout({ ...input, paymentMethod: "ONLINE" });
  const online = result.orders.filter((o) => o.paymentMethod === "ONLINE");
  if (online.length === 0) return { ...result, payment: null };
  const target =
    online.length === 1
      ? { purpose: "ORDER" as const, referenceId: online[0].id, baseKey: `pay:${online[0].checkoutKey ?? online[0].id}` }
      : online[0].orderGroupId
        ? { purpose: "ORDER_GROUP" as const, referenceId: online[0].orderGroupId, baseKey: `pay:group:${online[0].orderGroupId}` }
        : null;
  if (!target) throw conflict("These orders could not be grouped for one payment. Please contact support.");
  const payment = await payForOrders(input.userId, target.purpose, target.referenceId, target.baseKey);
  return { ...result, payment };
}

/** "Retry payment" for an online order whose payment failed or expired: same order(s), a new attempt. */
export async function retryOrderPayment(userId: string, orderId: string): Promise<OnlinePaymentView> {
  await assertOnlinePaymentsOn();
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order) throw notFound("Order");
  if (order.userId !== userId) throw forbidden("This is not your order.");
  if (order.paymentMethod !== "ONLINE") throw conflict("This order is not paid online.");
  const target = await targetForOrder(order);
  return payForOrders(userId, target.purpose, target.referenceId, target.baseKey);
}

async function targetForOrder(order: Order): Promise<{ purpose: PaymentPurpose; referenceId: string; baseKey: string }> {
  if (order.orderGroupId) {
    const groupIntents = await listIntentsFor("ORDER_GROUP", order.orderGroupId);
    if (groupIntents.length > 0) return { purpose: "ORDER_GROUP", referenceId: order.orderGroupId, baseKey: `pay:group:${order.orderGroupId}` };
  }
  return { purpose: "ORDER", referenceId: order.id, baseKey: `pay:${order.checkoutKey ?? order.id}` };
}

/**
 * The payment for these orders: the live attempt if there is one, nothing if
 * they are already paid, otherwise a new attempt (attempt n+1 after n ended
 * ones — so concurrent clicks compute the same key and share one intent).
 */
async function payForOrders(userId: string, purpose: PaymentPurpose, referenceId: string, baseKey: string): Promise<OnlinePaymentView> {
  const view = (row: PaymentIntentRow, alreadyPaid = false): OnlinePaymentView => ({
    intentId: row.id,
    status: row.status,
    amountPaise: row.amountPaise,
    redirectUrl: alreadyPaid ? null : redirectUrlOf(row),
    alreadyPaid,
  });

  let intents = await listIntentsFor(purpose, referenceId);
  const paid = intents.find(isPaid);
  if (paid) return view(paid, true);
  const live = intents.find(isLive);
  if (live && live.expiresAt && live.expiresAt.getTime() <= Date.now()) {
    // Past its time: ask the gateway now rather than offering a dead page.
    const { reconcileIntent } = await import("./processing");
    await reconcileIntent(live.id, "RECONCILE").catch((error) => console.error("[payments] reconcile before retry failed", error));
    intents = await listIntentsFor(purpose, referenceId);
    const nowPaid = intents.find(isPaid);
    if (nowPaid) return view(nowPaid, true);
  }
  const stillLive = intents.find(isLive);
  if (stillLive) {
    if (!stillLive.gatewayOrderId) {
      // Never reached the gateway (an earlier attempt to open it failed): open it now.
      const reopened = await createPaymentIntent(await intentInputFor(stillLive, userId));
      return view((await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, reopened.intent.id) }))!);
    }
    return view(stillLive);
  }

  const attempt = intents.length + 1;
  const key = `${baseKey}:${attempt}`;
  const customer = await customerOf(userId);

  const row = await db.transaction(async (tx) => {
    const locked = await ordersForIntent({ purpose, referenceId }, tx, true);
    const unpaid = locked.filter((o) => AWAITING_PAYMENT.includes(o.status));
    if (unpaid.length === 0) throw conflict("There is nothing left to pay on this order.");
    if (unpaid.some((o) => o.userId !== userId)) throw forbidden("This is not your order.");
    // Re-checked under the order locks: a concurrent click may have opened the attempt already.
    const existing = await tx.query.paymentIntents.findFirst({ where: eq(paymentIntents.idempotencyKey, key) });
    if (existing) return existing;
    // PENDING still holds the stock checkout took; PAYMENT_FAILED gave it back when the
    // previous attempt ended — take it again for this one.
    for (const order of unpaid) {
      if (order.status === "PAYMENT_FAILED") await holdStock(order, tx);
    }
    const amountPaise = unpaid.reduce((n, o) => n + o.totalPaise, 0);
    const reference = await referenceLabel(purpose, referenceId, unpaid, tx);
    const createdIntent = await createPaymentIntent(
      {
        purpose,
        referenceId,
        userId,
        amountPaise,
        customer: { id: userId, name: customer.name, email: customer.email, phone: customer.phone },
        description: reference,
        idempotencyKey: key,
        mode: "CHECKOUT",
      },
      tx,
    );
    // This attempt holds the orders' stock until it ends (released on FAILED / EXPIRED).
    await tx
      .update(paymentIntents)
      .set({ metadata: { ...(await metadataOf(createdIntent.intent.id, tx)), holdsStock: true, orderIds: unpaid.map((o) => o.id) } })
      .where(eq(paymentIntents.id, createdIntent.intent.id));
    return (await tx.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, createdIntent.intent.id) }))!;
  });
  return view(row);
}

async function metadataOf(intentId: string, tx: DbClient): Promise<Record<string, unknown>> {
  const row = await tx.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, intentId) });
  return (row?.metadata ?? {}) as Record<string, unknown>;
}

async function intentInputFor(row: PaymentIntentRow, userId: string) {
  const customer = await customerOf(userId);
  return {
    purpose: row.purpose,
    referenceId: row.referenceId,
    userId,
    amountPaise: row.amountPaise,
    customer: { id: userId, name: customer.name, email: customer.email, phone: customer.phone },
    description: row.description,
    idempotencyKey: row.idempotencyKey,
    mode: row.mode,
    returnPath: row.returnPath ?? undefined,
  };
}

async function referenceLabel(purpose: PaymentPurpose, referenceId: string, unpaid: Order[], tx: DbClient): Promise<string> {
  if (purpose === "ORDER_GROUP") {
    const [group] = await tx.select({ reference: orderGroups.reference }).from(orderGroups).where(eq(orderGroups.id, referenceId));
    return `GoKesari order ${group?.reference ?? unpaid.map((o) => o.orderNumber).join(", ")}`;
  }
  return `GoKesari order ${unpaid[0]?.orderNumber ?? ""}`.trim();
}

/* ------------------------------------------------- capture / failure hooks */

/**
 * CAPTURED_HANDLERS.ORDER / ORDER_GROUP: runs inside the capture transaction.
 * Every order still waiting for this payment becomes CONFIRMED and paid, with
 * the same event, audit and notices a wallet-paid order gets at checkout.
 */
export async function onOrderPaymentCaptured(intent: PaymentIntentRef, tx: DbClient): Promise<void> {
  const locked = await ordersForIntent(intent, tx, true);
  for (const order of locked) {
    if (!AWAITING_PAYMENT.includes(order.status)) continue;
    await confirmPaidOrder(order, intent, tx);
  }
}

async function confirmPaidOrder(order: Order, intent: PaymentIntentRef, tx: DbClient): Promise<void> {
  const now = new Date();
  const [shopRow] = await tx.select().from(shops).where(eq(shops.id, order.shopId));
  const acceptBy = await acceptByFor(now, order.placedWhileClosed ? order.expectedOpenAt : null);
  await tx
    .update(orders)
    .set({ status: "CONFIRMED", paidAt: now, acceptByAt: acceptBy, updatedAt: now })
    .where(eq(orders.id, order.id));
  await tx.insert(orderStatusHistory).values({
    orderId: order.id,
    previousStatus: order.status,
    newStatus: "CONFIRMED",
    changedBy: null,
    note: `Paid online (${intent.gateway})`,
  });
  await recordAudit(
    {
      actorId: order.userId,
      action: AUDIT_ACTIONS.ORDER_PLACED,
      entityType: "order",
      entityId: order.id,
      newValue: { orderNumber: order.orderNumber, totalPaise: order.totalPaise, paymentMethod: "ONLINE", paymentIntentId: intent.id },
    },
    tx,
  );
  await emitEvent(
    {
      type: "order.placed",
      subjectId: order.id,
      orderId: order.id,
      transition: { from: order.status, to: "CONFIRMED" },
      actor: { id: null, role: null },
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        buyerId: order.userId,
        shopOwnerId: shopRow?.ownerId ?? null,
        shopName: shopRow?.name ?? "the shop",
      },
    },
    tx,
  );
  // The same notices checkout sends for a wallet-paid order (orders.ts).
  await notify(
    {
      userId: order.userId,
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      title: "Order confirmed",
      body: `Your order ${order.orderNumber} from ${shopRow?.name ?? "the shop"} is confirmed.`,
      actionUrl: "/orders",
      dedupeKey: `order-confirmed:${order.id}`,
    },
    tx,
  );
  if (!shopRow) return;
  const items = await tx.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, order.id));
  const amount = `₹${(order.totalPaise / 100).toFixed(2)}`;
  if (order.placedWhileClosed) {
    await notify(
      {
        userId: shopRow.ownerId,
        type: NOTIFICATION_TYPES.SHOP_ORDER_WHILE_CLOSED,
        title: "New order while your shop is closed",
        body: `Order ${order.orderNumber} — ${items.length} item${items.length === 1 ? "" : "s"}, ${amount} (paid online) — was placed while your shop is closed. The customer chose to wait; you will get another alert when your shop opens.`,
        actionUrl: "/shop/orders",
        dedupeKey: `shop-new-order:${order.id}`,
      },
      tx,
    );
    await notify(
      {
        userId: order.userId,
        type: NOTIFICATION_TYPES.ORDER_QUEUED_SHOP_CLOSED,
        title: "Order placed — shop is closed now",
        body: `Your order ${order.orderNumber} was sent to ${shopRow.name}. The shop is closed right now, so it may be processed once it opens${order.expectedOpenAt ? ` (${formatShopTime(order.expectedOpenAt)})` : ""}.`,
        actionUrl: "/orders",
        dedupeKey: `order-queued:${order.id}`,
      },
      tx,
    );
  } else {
    await notify(
      {
        userId: shopRow.ownerId,
        type: NOTIFICATION_TYPES.SHOP_NEW_ORDER,
        title: "New order",
        body: `Order ${order.orderNumber} — ${items.length} item${items.length === 1 ? "" : "s"}, ${amount} (paid online).`,
        actionUrl: "/shop/orders",
        dedupeKey: `shop-new-order:${order.id}`,
      },
      tx,
    );
  }
}

/**
 * PAYMENT_ENDED_HANDLERS.ORDER / ORDER_GROUP: the attempt FAILED or EXPIRED.
 * Orders still waiting become PAYMENT_FAILED and the stock this attempt held
 * goes back on the shelf. The customer is told by the payment.failed /
 * payment.expired event; the order can be paid again ("retry payment").
 */
export async function onOrderPaymentEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", tx: DbClient): Promise<void> {
  const holdsStock = Boolean((intent.metadata as { holdsStock?: boolean } | null)?.holdsStock);
  const locked = await ordersForIntent(intent, tx, true);
  for (const order of locked) {
    if (!AWAITING_PAYMENT.includes(order.status)) continue;
    if (holdsStock) await releaseStock(order, tx);
    if (order.status === "PENDING") {
      await tx.update(orders).set({ status: "PAYMENT_FAILED", updatedAt: new Date() }).where(eq(orders.id, order.id));
      await tx.insert(orderStatusHistory).values({
        orderId: order.id,
        previousStatus: "PENDING",
        newStatus: "PAYMENT_FAILED",
        changedBy: null,
        note: to === "EXPIRED" ? "Online payment not completed in time" : "Online payment failed",
      });
      const [shopRow] = await tx.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, order.shopId));
      await emitEvent(
        {
          type: "order.status_changed",
          subjectId: order.id,
          orderId: order.id,
          transition: { from: "PENDING", to: "PAYMENT_FAILED" },
          actor: { id: null, role: null },
          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            buyerId: order.userId,
            shopOwnerId: shopRow?.ownerId ?? null,
            shopName: shopRow?.name ?? "the shop",
            reason: to === "EXPIRED" ? "payment expired" : "payment failed",
          },
        },
        tx,
      );
    }
  }
}

/**
 * An online order whose payment never opened (the gateway could not be
 * reached and the customer left): released like a failed attempt. Called by
 * the reconciliation job; false when it no longer applies.
 */
export async function failOrphanOnlineOrder(orderId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
    if (!order || order.paymentMethod !== "ONLINE" || order.status !== "PENDING") return false;
    const refs = await listIntentsFor("ORDER", order.id, tx);
    const groupRefs = order.orderGroupId ? await listIntentsFor("ORDER_GROUP", order.orderGroupId, tx) : [];
    if (refs.length + groupRefs.length > 0) return false;
    await releaseStock(order, tx);
    await tx.update(orders).set({ status: "PAYMENT_FAILED", updatedAt: new Date() }).where(eq(orders.id, order.id));
    await tx.insert(orderStatusHistory).values({
      orderId: order.id,
      previousStatus: "PENDING",
      newStatus: "PAYMENT_FAILED",
      changedBy: null,
      note: "Online payment was never started",
    });
    const [shopRow] = await tx.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, order.shopId));
    await emitEvent(
      {
        type: "order.status_changed",
        subjectId: order.id,
        orderId: order.id,
        transition: { from: "PENDING", to: "PAYMENT_FAILED" },
        actor: { id: null, role: null },
        payload: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          buyerId: order.userId,
          shopOwnerId: shopRow?.ownerId ?? null,
          shopName: shopRow?.name ?? "the shop",
          reason: "payment never started",
        },
      },
      tx,
    );
    return true;
  });
}

/* ------------------------------------------------------------ cancel */

/**
 * cancelOrder() for an ONLINE order (called from orders.ts under the order's
 * row lock). Refuses while a payment attempt is open (money could still be
 * taken); says whether the stock is already back (a failed / expired attempt
 * released it).
 */
export async function onlineCancelPolicy(order: Order, tx: DbClient): Promise<{ stockAlreadyReleased: boolean }> {
  if (AWAITING_PAYMENT.includes(order.status)) {
    const refs: { purpose: PaymentPurpose; id: string }[] = [{ purpose: "ORDER", id: order.id }];
    if (order.orderGroupId) refs.push({ purpose: "ORDER_GROUP", id: order.orderGroupId });
    for (const ref of refs) {
      const intents = await listIntentsFor(ref.purpose, ref.id, tx);
      if (intents.some(isLive)) {
        throw conflict("A payment for this order is in progress. Wait for it to finish (a few minutes), then try again.");
      }
    }
  }
  return { stockAlreadyReleased: order.status === "PAYMENT_FAILED" };
}

/**
 * A paid ONLINE order was cancelled: the refund goes back to the original
 * method (recorded now, in the cancel's transaction, and sent to the gateway
 * by the reconciliation job once it has committed). The order waits in
 * REFUND_PENDING and becomes REFUNDED when the gateway confirms.
 */
export async function refundCancelledOnlineOrder(
  order: Order,
  amountPaise: number,
  goodsOnly: boolean,
  actor: { id: string; role: UserRole } | null,
  tx: DbClient,
): Promise<boolean> {
  const intent =
    (await findCapturedIntent("ORDER", order.id, tx)) ??
    (order.orderGroupId ? await findCapturedIntent("ORDER_GROUP", order.orderGroupId, tx) : null);
  if (!intent) return false;
  await refundPaymentIntent(
    {
      intentId: intent.id,
      amountPaise: Math.min(amountPaise, intent.amountPaise),
      reason: `Order ${order.orderNumber} cancelled`,
      idempotencyKey: `refund:order:${order.id}`,
      orderId: order.id,
    },
    tx,
  );
  if (goodsOnly) await postRetainedDeliveryFee(order, tx);
  await tx.update(orders).set({ status: "REFUND_PENDING", updatedAt: new Date() }).where(eq(orders.id, order.id));
  await tx.insert(orderStatusHistory).values({
    orderId: order.id,
    previousStatus: "CANCELLED",
    newStatus: "REFUND_PENDING",
    changedBy: actor?.id ?? null,
    note: goodsOnly ? "Refund to the original payment method (goods only; delivery fee retained)" : "Refund to the original payment method",
  });
  return true;
}

/* ------------------------------------------------------- customer view */

export interface PaymentStatusView {
  intentId: string;
  status: PaymentIntentRow["status"];
  amountPaise: number;
  refundedPaise: number;
  reference: string;
  failureReason: string | null;
  redirectUrl: string | null;
  canRetry: boolean;
  orders: { id: string; orderNumber: string; status: OrderStatus }[];
}

/** The return page's view of one intent — the customer's own only. Re-asks the gateway while it is still open. */
export async function getPaymentStatusForCustomer(userId: string, intentId: string): Promise<PaymentStatusView> {
  let row = await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, intentId) });
  if (!row || row.userId !== userId) throw notFound("Payment");
  const stale = !row.lastReconciledAt || Date.now() - row.lastReconciledAt.getTime() > 10_000;
  if (isLive(row) && row.gatewayOrderId && stale) {
    const { reconcileIntent } = await import("./processing");
    await reconcileIntent(row.id, "RECONCILE").catch((error) => console.error("[payments] status refresh failed", error));
    row = (await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, intentId) }))!;
  }
  const list = row.purpose === "ORDER" || row.purpose === "ORDER_GROUP" ? await ordersForIntent(row, db, false) : [];
  const ended = row.status === "FAILED" || row.status === "EXPIRED";
  const newer = ended
    ? await db
        .select({ id: paymentIntents.id })
        .from(paymentIntents)
        .where(and(eq(paymentIntents.purpose, row.purpose), eq(paymentIntents.referenceId, row.referenceId), inArray(paymentIntents.status, ["CREATED", "PENDING", "AUTHORIZED", "CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"])))
        .orderBy(desc(paymentIntents.createdAt))
        .limit(1)
    : [];
  return {
    intentId: row.id,
    status: row.status,
    amountPaise: row.amountPaise,
    refundedPaise: row.refundedPaise,
    reference: row.description,
    failureReason: row.failureReason,
    redirectUrl: isLive(row) ? redirectUrlOf(row) : null,
    canRetry: ended && newer.length === 0 && list.some((o) => o.status === "PAYMENT_FAILED"),
    orders: list.map((o) => ({ id: o.id, orderNumber: o.orderNumber, status: o.status })),
  };
}

export { toIntentRef };
