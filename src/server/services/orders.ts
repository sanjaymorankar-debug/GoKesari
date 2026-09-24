/**
 * Order service (requirements §17, §22–§23, §41).
 *
 * Checkout is the second financial hot path after the wallet. Its guarantees:
 *
 *  - **Server-authoritative pricing.** Prices, quantities and totals are read
 *    from the database at checkout time. Nothing monetary is accepted from the
 *    client (§47).
 *  - **Atomicity.** Order creation, stock consumption and the wallet debit all
 *    happen in ONE transaction. A failure at any step leaves no order and no
 *    deduction.
 *  - **Idempotency.** A caller-supplied request id is folded into the wallet
 *    transaction key, so a double-submitted checkout returns the original order
 *    instead of charging twice.
 *  - **Per-shop split.** A cart spanning several shops becomes one order per
 *    shop, each paid for independently (§17).
 */
import { and, desc, eq, inArray, like } from "drizzle-orm";

import { conflict, forbidden, invalidTransition, notFound, validationFailed } from "@/lib/errors";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { lineTotalPaise, sumPaise } from "@/lib/money";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  orderItems,
  orderStatusHistory,
  orders,
  productCategories,
  products,
  shopProducts,
  shops,
  walletTransactions,
  type DeliveryWindow,
  type Order,
  type OrderItemFulfilment,
  type OrderStatus,
  type OrderType,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { clearCartForShop, computeDeliveryFee, getCart } from "./cart";
import { consumeOnlineStock, loadPurchasableShopProduct, restockOnline } from "./catalogue";
import { creditDeliveryEarnings } from "./delivery-earnings";
import { DELIVERY_WINDOW_MINUTES, getFeasibleDeliveryWindows } from "./delivery-feasibility";
import { notifyOpenStockAlerts } from "./inventory-alerts";
import { recordOrderFinancials } from "./finance";
import { NOTIFICATION_TYPES, notify, type NotificationType } from "./notifications";
import { applyWalletMutation, refundOriginalDebit } from "./wallet";

/**
 * A delivery assignment is still "in play" — offered, accepted, or already
 * picked up — and needs explicit handling if the order it belongs to gets
 * cancelled. Deliberately a narrower, order-cancellation-scoped concept from
 * delivery-assignment.ts's own ACTIVE_ASSIGNMENT_STATUSES (partner
 * busy-checking) — not imported from there, to avoid a circular import
 * (delivery-assignment.ts already imports updateOrderStatus from this file).
 */
const ACTIVE_DELIVERY_ORDER_STATUSES = ["OFFERED", "ACCEPTED", "PICKED_UP"] as const;

/* ------------------------------------------------------- state machine */

/**
 * The approved order state machine (see the orderStatusEnum doc comment in
 * schema.ts for the mapping to DRAFT/PAYMENT_PENDING/PAID/SHOP_PENDING).
 *
 * Kept compatible with what already worked:
 *  - CONFIRMED -> PREPARING stays legal (subscription orders and the older
 *    one-click "Start preparing" path); ACCEPTED is the explicit step.
 *  - READY -> OUT_FOR_DELIVERY / DELIVERED stays legal for shops that deliver
 *    themselves or hand over in store. Once a rider accepts (ASSIGNED), only
 *    the rider flow (pickup code -> OTP) can move the order on.
 *  - ASSIGNED -> READY lets a reassignment put the order back in the queue.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED", "PAYMENT_FAILED", "WALLET_INSUFFICIENT"],
  WALLET_INSUFFICIENT: ["CONFIRMED", "CANCELLED"],
  PAYMENT_FAILED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["ACCEPTED", "PREPARING", "CANCELLED", "REFUND_PENDING"],
  ACCEPTED: ["PREPARING", "CANCELLED", "REFUND_PENDING"],
  PREPARING: ["READY", "CANCELLED", "REFUND_PENDING"],
  READY: ["ASSIGNED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "REFUND_PENDING"],
  ASSIGNED: ["READY", "PICKED_UP", "CANCELLED", "REFUND_PENDING"],
  PICKED_UP: ["OUT_FOR_DELIVERY", "FAILED", "CANCELLED", "REFUND_PENDING"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED", "CANCELLED", "REFUND_PENDING"],
  FAILED: ["OUT_FOR_DELIVERY", "RETURNED", "CANCELLED", "REFUND_PENDING"],
  RETURNED: ["CANCELLED", "REFUND_PENDING"],
  DELIVERED: ["DISPUTED", "REFUND_PENDING"],
  DISPUTED: ["DELIVERED", "REFUND_PENDING"],
  CANCELLED: ["REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED"],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Whether the customer has already been charged at each status. A Record,
 * not a hand-kept array, so adding a status to the enum fails to compile
 * until it is classified here (the D8 implementation note: a missed entry
 * made cancelOrder skip the refund of a paid order).
 */
const IS_PAID_STATUS: Record<OrderStatus, boolean> = {
  PENDING: false,
  WALLET_INSUFFICIENT: false,
  PAYMENT_FAILED: false,
  CONFIRMED: true,
  ACCEPTED: true,
  PREPARING: true,
  READY: true,
  ASSIGNED: true,
  PICKED_UP: true,
  OUT_FOR_DELIVERY: true,
  FAILED: true,
  RETURNED: true,
  DELIVERED: true,
  DISPUTED: true,
  CANCELLED: false,
  REFUND_PENDING: false,
  REFUNDED: false,
};
const PAID_STATUSES: readonly OrderStatus[] = (Object.keys(IS_PAID_STATUS) as OrderStatus[]).filter(
  (status) => IS_PAID_STATUS[status],
);

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  ACCEPTED: "Accepted by shop",
  PREPARING: "Preparing",
  READY: "Ready",
  ASSIGNED: "Rider assigned",
  PICKED_UP: "Picked up",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
  RETURNED: "Returned to shop",
  DISPUTED: "Disputed",
  CANCELLED: "Cancelled",
  PAYMENT_FAILED: "Payment failed",
  WALLET_INSUFFICIENT: "Awaiting wallet top-up",
  REFUND_PENDING: "Refund pending",
  REFUNDED: "Refunded",
};

/* ------------------------------------------------------------ checkout */

export interface CheckoutInput {
  userId: string;
  addressId?: string | null;
  /**
   * Stable id for this checkout attempt, supplied by the client. Re-submitting
   * the same id returns the original orders instead of charging again.
   */
  requestId: string;
  notes?: string | null;
  /**
   * Requested delivery window per shop (cart spans several shops → one order
   * each). Re-validated against live feasibility at order-creation time — a
   * client's earlier selection is a hint, never trusted outright, since a
   * rider may have gone offline between browsing and paying (§21: never
   * promise a window the system can't actually back).
   */
  deliveryWindows?: Record<string, DeliveryWindow>;
  /** PERSONAL (default) or B2B. B2B also needs `buyerShopId` and `actorRole`. */
  orderType?: OrderType;
  /** B2B only: the approved shop, owned by the user, that is buying. */
  buyerShopId?: string | null;
  /** The caller's role — B2B is refused unless it holds ORDER_PLACE_B2B. */
  actorRole?: UserRole;
}

export interface CheckoutResult {
  orders: Order[];
  deduplicated: boolean;
}

export async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
  if (!input.requestId?.trim()) {
    throw validationFailed("A checkout request id is required.");
  }

  // Replay check comes FIRST, before the empty-cart guard. A successful
  // checkout clears the cart, so a double-submitted request would otherwise be
  // told its cart is empty even though its order went through.
  const replayed = await findOrdersForRequest(input.userId, input.requestId);
  if (replayed.length > 0) {
    return { orders: replayed, deduplicated: true };
  }

  const orderType: OrderType = input.orderType ?? "PERSONAL";
  const buyerShopId = orderType === "B2B" ? await resolveBuyerShop(input) : null;
  if (orderType === "PERSONAL" && input.buyerShopId) {
    throw validationFailed("A personal order cannot be placed for a shop.");
  }

  const cart = await getCart(input.userId);
  if (cart.groups.length === 0) {
    throw validationFailed("Your cart is empty.");
  }
  if (buyerShopId && cart.groups.some((g) => g.shop.id === buyerShopId)) {
    throw validationFailed("A shop cannot place a business order with itself.");
  }

  const purchasableGroups = cart.groups.filter((g) =>
    g.lines.some((l) => l.purchasable),
  );
  if (purchasableGroups.length === 0) {
    throw conflict(
      "None of the items in your cart can be ordered online right now.",
    );
  }

  const addressSnapshot = input.addressId
    ? await loadAddressSnapshot(input.userId, input.addressId)
    : null;

  const created: Order[] = [];
  let anyDeduplicated = false;

  // One transaction per shop: a problem with one shop's order must not roll back
  // a sibling shop's successful order.
  for (const group of purchasableGroups) {
    const idempotencyKey = `checkout:${input.userId}:${input.requestId}:${group.shop.id}`;

    // Fast path: this shop's order was already placed under this request id.
    const priorTxn = await db.query.walletTransactions.findFirst({
      where: eq(walletTransactions.idempotencyKey, idempotencyKey),
    });
    if (priorTxn?.orderId) {
      const existing = await db.query.orders.findFirst({
        where: eq(orders.id, priorTxn.orderId),
      });
      if (existing) {
        created.push(existing);
        anyDeduplicated = true;
        continue;
      }
    }

    const requestedWindow = input.deliveryWindows?.[group.shop.id];
    const { deliveryWindow, promisedByAt } = requestedWindow
      ? await resolvePromisedWindow(group.shop.id, requestedWindow)
      : { deliveryWindow: null, promisedByAt: null };

    const { order, shopOwnerId } = await db.transaction(async (tx) => {
      const lines: {
        shopProductId: string;
        productName: string;
        unit: string;
        unitPricePaise: number;
        quantityUnits: number;
        quantityMilli: number;
        lineTotalPaise: number;
      }[] = [];

      // Re-validate and re-price every line inside the transaction. The cart
      // view is a hint; this is the authority.
      for (const line of group.lines) {
        if (!line.purchasable) continue;

        const loaded = await loadPurchasableShopProduct(
          line.shopProductId,
          line.quantity,
          tx,
        );
        const quantityMilli = line.quantity * loaded.product.unitSizeMilli;
        lines.push({
          shopProductId: loaded.shopProduct.id,
          productName: loaded.product.name,
          unit: loaded.product.unit,
          unitPricePaise: loaded.unitPricePaise,
          quantityUnits: line.quantity,
          quantityMilli,
          lineTotalPaise: lineTotalPaise(loaded.unitPricePaise, quantityMilli),
        });
      }

      if (lines.length === 0) {
        throw conflict("These items are no longer available online.");
      }

      const subtotalPaise = sumPaise(lines.map((l) => l.lineTotalPaise));
      const [shopRow] = await tx
        .select()
        .from(shops)
        .where(eq(shops.id, group.shop.id));
      const deliveryFeePaise = computeDeliveryFee(shopRow, subtotalPaise);
      const taxPaise = 0;
      const totalPaise = subtotalPaise + deliveryFeePaise + taxPaise;

      const [orderRow] = await tx
        .insert(orders)
        .values({
          orderNumber: generateOrderNumber(),
          userId: input.userId,
          shopId: group.shop.id,
          addressId: input.addressId ?? null,
          deliveryAddressSnapshot: addressSnapshot,
          status: "PENDING",
          source: "DIRECT",
          orderType,
          buyerShopId,
          subtotalPaise,
          deliveryFeePaise,
          taxPaise,
          totalPaise,
          deliveryWindow,
          promisedByAt,
          notes: input.notes ?? null,
        })
        .returning();

      await tx.insert(orderItems).values(
        lines.map((l) => ({
          orderId: orderRow.id,
          shopProductId: l.shopProductId,
          productNameSnapshot: l.productName,
          unitSnapshot: l.unit,
          unitPricePaise: l.unitPricePaise,
          quantityMilli: l.quantityMilli,
          lineTotalPaise: l.lineTotalPaise,
        })),
      );

      for (const l of lines) {
        await consumeOnlineStock(
          l.shopProductId,
          l.quantityUnits,
          "Online order",
          tx,
          orderRow.id,
        );
      }

      // Charge the wallet. Throws INSUFFICIENT_BALANCE, which rolls the whole
      // transaction back — no order, no stock consumed, no deduction (§23).
      await applyWalletMutation(
        {
          userId: input.userId,
          amountPaise: totalPaise,
          type: "PRODUCT_PURCHASE",
          idempotencyKey,
          description: `Order ${orderRow.orderNumber} — ${shopRow.name}`,
          orderId: orderRow.id,
        },
        tx,
      );

      const [confirmed] = await tx
        .update(orders)
        .set({ status: "CONFIRMED", paidAt: new Date(), updatedAt: new Date() })
        .where(eq(orders.id, orderRow.id))
        .returning();

      await tx.insert(orderStatusHistory).values({
        orderId: orderRow.id,
        previousStatus: "PENDING",
        newStatus: "CONFIRMED",
        changedBy: input.userId,
        note: "Paid from wallet",
      });

      await recordAudit(
        {
          actorId: input.userId,
          action: AUDIT_ACTIONS.ORDER_PLACED,
          entityType: "order",
          entityId: orderRow.id,
          newValue: { orderNumber: orderRow.orderNumber, totalPaise },
        },
        tx,
      );

      // DEF-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): a paid order
      // previously notified nobody. The customer learns it's confirmed; the
      // shop learns it has a new order to prepare — there was no "new order"
      // notification type at all before this.
      await notify(
        {
          userId: input.userId,
          type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
          title: "Order confirmed",
          body: `Your order ${orderRow.orderNumber} from ${shopRow.name} is confirmed.`,
          actionUrl: `/orders`,
        },
        tx,
      );
      await notify(
        {
          userId: shopRow.ownerId,
          type: NOTIFICATION_TYPES.SHOP_NEW_ORDER,
          title: "New order",
          body: `Order ${orderRow.orderNumber} — ${lines.length} item${lines.length === 1 ? "" : "s"}, ₹${(totalPaise / 100).toFixed(2)}.`,
          actionUrl: "/shop/orders",
        },
        tx,
      );

      await clearCartForShop(input.userId, group.shop.id, tx);
      return { order: confirmed, shopOwnerId: shopRow.ownerId };
    });

    created.push(order);
    // Deliberately AFTER the transaction commits, using bare db — a failed
    // notification must never roll back a paid order (see
    // notifyOpenStockAlerts's own doc comment). Safe to call unconditionally:
    // it dedupes per alert id, so it never re-notifies about one already sent.
    await notifyOpenStockAlerts(group.shop.id, shopOwnerId);
  }

  return { orders: created, deduplicated: anyDeduplicated };
}

/**
 * Validates a B2B checkout's buying shop: the caller's role must allow B2B,
 * and the shop must be theirs (an admin may buy for any shop) and APPROVED.
 */
async function resolveBuyerShop(input: CheckoutInput): Promise<string> {
  if (!input.actorRole || !can(input.actorRole, PERMISSIONS.ORDER_PLACE_B2B)) {
    throw forbidden("Your account cannot place business orders.");
  }
  if (!input.buyerShopId) {
    throw validationFailed("Choose the shop this business order is for.");
  }
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, input.buyerShopId) });
  if (!shop || (shop.ownerId !== input.userId && input.actorRole !== "ADMIN")) {
    throw forbidden("You can only place business orders for your own shop.");
  }
  if (shop.status !== "APPROVED" || shop.deletedAt) {
    throw conflict("Only an approved shop can place business orders.");
  }
  return shop.id;
}

/* --------------------------------------------------------- transitions */

export async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  actor: { id: string; role: UserRole },
  note?: string,
  client?: DbClient,
): Promise<Order> {
  const run = async (tx: DbClient): Promise<Order> => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!order) throw notFound("Order");

    if (!canTransition(order.status, newStatus)) {
      throw invalidTransition(
        ORDER_STATUS_LABELS[order.status],
        ORDER_STATUS_LABELS[newStatus],
      );
    }

    const [updated] = await tx
      .update(orders)
      .set({
        status: newStatus,
        updatedAt: new Date(),
        ...(newStatus === "CANCELLED" ? { cancellationReason: note ?? null } : {}),
        ...(newStatus === "ACCEPTED" ? { acceptedAt: new Date() } : {}),
        ...(newStatus === "READY" ? { packedAt: order.packedAt ?? new Date() } : {}),
      })
      .where(eq(orders.id, orderId))
      .returning();

    await tx.insert(orderStatusHistory).values({
      orderId,
      previousStatus: order.status,
      newStatus,
      changedBy: actor.id,
      note: note ?? null,
    });

    // Slice 6: snapshot the order's GMV / commission / shop payable the moment
    // it is delivered, in the same transaction (idempotent).
    if (newStatus === "DELIVERED") {
      await recordOrderFinancials(orderId, tx);
    }

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.ORDER_STATUS_CHANGED,
        entityType: "order",
        entityId: orderId,
        previousValue: { status: order.status },
        newValue: { status: newStatus, note },
      },
      tx,
    );

    // DEF-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): these
    // notification types were defined but never emitted. Covers both a
    // direct shop/operator status change and the same transitions arriving
    // via delivery-assignment.ts's markPickedUp/markDelivered, since both
    // paths go through this one function.
    const CUSTOMER_STATUS_NOTIFICATIONS: Partial<Record<OrderStatus, NotificationType>> = {
      ACCEPTED: NOTIFICATION_TYPES.ORDER_ACCEPTED,
      READY: NOTIFICATION_TYPES.ORDER_READY,
      ASSIGNED: NOTIFICATION_TYPES.ORDER_ASSIGNED,
      FAILED: NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED,
      OUT_FOR_DELIVERY: NOTIFICATION_TYPES.ORDER_OUT_FOR_DELIVERY,
      DELIVERED: NOTIFICATION_TYPES.ORDER_DELIVERED,
    };
    const notificationType = CUSTOMER_STATUS_NOTIFICATIONS[newStatus];
    if (notificationType) {
      await notify(
        {
          userId: order.userId,
          type: notificationType,
          title: `Order ${ORDER_STATUS_LABELS[newStatus].toLowerCase()}`,
          body: `Your order ${order.orderNumber} is ${ORDER_STATUS_LABELS[newStatus].toLowerCase()}.`,
          actionUrl: "/orders",
        },
        tx,
      );
    }

    return updated;
  };
  return client ? run(client) : db.transaction(run);
}

export interface CancelOrderOptions {
  /**
   * True when the actor is the customer cancelling their OWN order through
   * self-service (as opposed to a shop/operator acting with privilege).
   * Governs D10, the resolved cancellation policy — see
   * docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md DEF-08:
   *
   *   CONFIRMED            -> self-cancel allowed, full refund
   *   PREPARING / READY    -> self-cancel BLOCKED (shop/operator only)
   *   OUT_FOR_DELIVERY     -> self-cancel allowed again, GOODS-ONLY refund
   *                           (delivery fee kept); rider still paid
   *
   * Extension for the statuses added in Slice 3/4 (same reasoning, pending
   * the user's confirmation): ACCEPTED and ASSIGNED behave like PREPARING /
   * READY (blocked); PICKED_UP behaves like OUT_FOR_DELIVERY (goods only);
   * FAILED / RETURNED / DISPUTED are handled by the shop or an operator.
   *
   * Shop/operator-initiated cancellation (this option false or omitted) is
   * unrestricted and always a full refund at every status, exactly as
   * before this option existed.
   */
  selfService?: boolean;
}

/**
 * Cancels an order and refunds the wallet when it had already been paid.
 * The refund is idempotent on the order id, so a repeated cancel cannot pay out
 * twice (§48). Also restores the stock checkout() consumed (DEF-01) and, if a
 * delivery was already in progress, cancels that assignment and settles the
 * rider's earnings per D10 (DEF-08) — see CancelOrderOptions above.
 */
export async function cancelOrder(
  orderId: string,
  actor: { id: string; role: UserRole },
  reason: string,
  options: CancelOrderOptions = {},
): Promise<Order> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    if (!order) throw notFound("Order");

    if (!canTransition(order.status, "CANCELLED")) {
      throw invalidTransition(ORDER_STATUS_LABELS[order.status], "Cancelled");
    }

    // D10: a customer cancelling their own order is blocked while the shop is
    // actively assembling it — there is no clean undo for picked/packed work,
    // so only the shop or an operator may cancel from here. Does not apply to
    // a shop/operator-privileged cancel, which stays unrestricted.
    if (
      options.selfService &&
      (["ACCEPTED", "PREPARING", "READY", "ASSIGNED"] as OrderStatus[]).includes(order.status)
    ) {
      throw conflict(
        "This order is already being prepared. Please contact the shop to cancel it.",
      );
    }
    if (
      options.selfService &&
      (["FAILED", "RETURNED", "DISPUTED"] as OrderStatus[]).includes(order.status)
    ) {
      throw conflict("Please contact support about this order.");
    }

    const wasPaid = PAID_STATUSES.includes(order.status) && order.paidAt != null;
    // D10: self-cancelling a dispatched order refunds the goods only — the
    // shop and rider have already done the work of picking, packing and
    // dispatching it, so the delivery fee is kept. Every other case (any
    // shop/operator cancel, or a self-cancel before dispatch) still refunds
    // the full total, unchanged from before.
    const goodsOnlyRefund =
      Boolean(options.selfService) &&
      (order.status === "OUT_FOR_DELIVERY" || order.status === "PICKED_UP");

    const [updated] = await tx
      .update(orders)
      .set({
        status: "CANCELLED",
        cancellationReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId))
      .returning();

    await tx.insert(orderStatusHistory).values({
      orderId,
      previousStatus: order.status,
      newStatus: "CANCELLED",
      changedBy: actor.id,
      note: reason,
    });

    // DEF-02: notify the customer their order was cancelled — only when
    // someone OTHER than themselves did it (a shop/operator cancel), since a
    // customer doesn't need to be told about their own action.
    if (actor.id !== order.userId) {
      await notify(
        {
          userId: order.userId,
          type: NOTIFICATION_TYPES.ORDER_CANCELLED,
          title: "Order cancelled",
          body: `Your order ${order.orderNumber} was cancelled: ${reason}`,
          actionUrl: "/orders",
        },
        tx,
      );
    }

    // DEF-01: every cancellation restores the stock checkout() consumed —
    // previously nothing did, so a cancelled order permanently lost the unit.
    // Restocked regardless of payment status or who cancelled: checkout()
    // consumes stock unconditionally when the order is created, so its
    // reversal is unconditional too. quantityMilli / unitSizeMilli recovers
    // the whole-unit quantity restockOnline expects (it was computed the
    // other way around at checkout: quantityMilli = quantity * unitSizeMilli).
    //
    // Slice 3: a REMOVED line is not restocked (the shop reported it
    // unavailable, so there is nothing to put back), and a SUBSTITUTED line
    // restocks the substitute that was actually taken from stock.
    const items = await tx
      .select({
        shopProductId: orderItems.shopProductId,
        quantityMilli: orderItems.quantityMilli,
        fulfilmentStatus: orderItems.fulfilmentStatus,
        substituteShopProductId: orderItems.substituteShopProductId,
        substituteQuantityMilli: orderItems.substituteQuantityMilli,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    const restockLines = items
      .filter((i) => i.fulfilmentStatus !== "REMOVED")
      .map((i) =>
        i.fulfilmentStatus === "SUBSTITUTED" && i.substituteShopProductId && i.substituteQuantityMilli
          ? { shopProductId: i.substituteShopProductId, quantityMilli: i.substituteQuantityMilli }
          : { shopProductId: i.shopProductId, quantityMilli: i.quantityMilli },
      );
    const unitSizes =
      restockLines.length > 0
        ? await tx
            .select({ id: shopProducts.id, unitSizeMilli: products.unitSizeMilli })
            .from(shopProducts)
            .innerJoin(products, eq(shopProducts.productId, products.id))
            .where(inArray(shopProducts.id, restockLines.map((l) => l.shopProductId)))
        : [];
    const unitSizeById = new Map(unitSizes.map((u) => [u.id, u.unitSizeMilli]));
    const lines = restockLines.map((l) => ({
      ...l,
      unitSizeMilli: unitSizeById.get(l.shopProductId) ?? 1000,
    }));
    for (const line of lines) {
      const quantityUnits = Math.round(line.quantityMilli / line.unitSizeMilli);
      if (quantityUnits > 0) {
        await restockOnline(
          line.shopProductId,
          quantityUnits,
          `Order ${order.orderNumber} cancelled`,
          actor.id,
          tx,
        );
      }
    }

    // DEF-08/DEF-04: an in-progress delivery is explicitly cancelled here —
    // previously nothing touched delivery_orders on an order cancel, so the
    // rider's assignment was orphaned (stuck "busy" forever, and their
    // eventual markDelivered would throw, unpaid). The rider still earns for
    // a trip they already picked up, per D10 — creditDeliveryEarnings now
    // allows a CANCELLED-after-pickup assignment as well as a DELIVERED one.
    const [activeDelivery] = await tx
      .select()
      .from(deliveryOrders)
      .where(
        and(
          eq(deliveryOrders.orderId, orderId),
          inArray(deliveryOrders.status, ACTIVE_DELIVERY_ORDER_STATUSES),
        ),
      );
    if (activeDelivery) {
      const wasPickedUp = activeDelivery.pickedUpAt != null;
      await tx
        .update(deliveryOrders)
        .set({
          status: "CANCELLED",
          cancelledAt: new Date(),
          cancellationReason: `Order cancelled: ${reason}`,
          updatedAt: new Date(),
        })
        .where(eq(deliveryOrders.id, activeDelivery.id));
      if (wasPickedUp) {
        await creditDeliveryEarnings(activeDelivery.id, tx);
      }
    }

    // Removed / cheaper-substituted lines were already refunded and deducted
    // from totalPaise/subtotalPaise, so these always reflect what is still held.
    const refundAmountPaise = goodsOnlyRefund ? order.subtotalPaise : order.totalPaise;
    if (wasPaid && refundAmountPaise > 0) {
      // Preserves the original customer-funded / promotional split (§29) —
      // does not simply credit a lump customer-funded sum, which would
      // silently convert any promotional credit the order used into real,
      // withdrawable-feeling money. A goods-only refund restores the same
      // proportion of the promotional split as the amount being refunded.
      await refundOriginalDebit(
        {
          userId: order.userId,
          referenceType: "orderId",
          referenceId: order.id,
          idempotencyKey: `refund:order:${order.id}`,
          description: goodsOnlyRefund
            ? `Goods refund for cancelled order ${order.orderNumber} (delivery fee retained — order was already dispatched)`
            : `Refund for cancelled order ${order.orderNumber}`,
          createdBy: actor.id,
          amountPaise: refundAmountPaise,
        },
        tx,
      );
      // REFUNDED is the closest existing status for a goods-only refund too —
      // there is no PARTIALLY_REFUNDED state yet (tracked under decision D8
      // in the roadmap). cancellationReason above already records that the
      // delivery fee was retained.
      await tx
        .update(orders)
        .set({ status: "REFUNDED", updatedAt: new Date() })
        .where(eq(orders.id, orderId));
      await tx.insert(orderStatusHistory).values({
        orderId,
        previousStatus: "CANCELLED",
        newStatus: "REFUNDED",
        changedBy: actor.id,
        note: goodsOnlyRefund ? "Wallet refunded (goods only; delivery fee retained)" : "Wallet refunded",
      });
      return { ...updated, status: "REFUNDED" as OrderStatus };
    }

    return updated;
  });
}

/* ---------------------------------------------------------- retrieval */

export interface OrderDetail extends Order {
  items: {
    id: string;
    shopProductId: string;
    productNameSnapshot: string;
    unitSnapshot: string;
    unitPricePaise: number;
    quantityMilli: number;
    lineTotalPaise: number;
    fulfilmentStatus: OrderItemFulfilment;
    substituteNameSnapshot: string | null;
    substituteUnitSnapshot: string | null;
    substituteQuantityMilli: number | null;
    substituteLineTotalPaise: number | null;
    fulfilmentNote: string | null;
  }[];
  shopName: string;
  shopSlug: string;
}

export async function getOrder(orderId: string): Promise<OrderDetail | undefined> {
  const [row] = await db
    .select({ order: orders, shopName: shops.name, shopSlug: shops.slug })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) return undefined;

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  return {
    ...row.order,
    shopName: row.shopName,
    shopSlug: row.shopSlug,
    items,
  };
}

export async function listOrdersForUser(
  userId: string,
  options: { limit?: number; offset?: number; orderType?: OrderType } = {},
): Promise<OrderDetail[]> {
  const rows = await db
    .select({ order: orders, shopName: shops.name, shopSlug: shops.slug })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(
      options.orderType
        ? and(eq(orders.userId, userId), eq(orders.orderType, options.orderType))
        : eq(orders.userId, userId),
    )
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(options.limit ?? 25, 100))
    .offset(options.offset ?? 0);

  return attachItems(rows);
}

export async function listOrdersForShop(
  shopId: string,
  options: {
    status?: OrderStatus;
    source?: "DIRECT" | "SUBSCRIPTION";
    limit?: number;
  } = {},
): Promise<OrderDetail[]> {
  const rows = await db
    .select({ order: orders, shopName: shops.name, shopSlug: shops.slug })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(
      and(
        eq(orders.shopId, shopId),
        options.status ? eq(orders.status, options.status) : undefined,
        options.source ? eq(orders.source, options.source) : undefined,
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(options.limit ?? 50, 200));

  return attachItems(rows);
}

async function attachItems(
  rows: { order: Order; shopName: string; shopSlug: string }[],
): Promise<OrderDetail[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.order.id);
  const items = await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, ids));

  const byOrder = new Map<string, typeof items>();
  for (const item of items) {
    const list = byOrder.get(item.orderId) ?? [];
    list.push(item);
    byOrder.set(item.orderId, list);
  }

  return rows.map((r) => ({
    ...r.order,
    shopName: r.shopName,
    shopSlug: r.shopSlug,
    items: byOrder.get(r.order.id) ?? [],
  }));
}

/* ------------------------------------------------------------ helpers */

/**
 * Finds orders already placed under a checkout request id.
 *
 * Wallet transaction keys are `checkout:<userId>:<requestId>:<shopId>`, so a
 * prefix match recovers every per-shop order belonging to one attempt.
 */
async function findOrdersForRequest(
  userId: string,
  requestId: string,
): Promise<Order[]> {
  const prefix = `checkout:${userId}:${requestId}:`;
  const priorTxns = await db
    .select({ orderId: walletTransactions.orderId })
    .from(walletTransactions)
    .where(like(walletTransactions.idempotencyKey, `${prefix}%`));

  const orderIds = priorTxns
    .map((t) => t.orderId)
    .filter((id): id is string => id !== null);
  if (orderIds.length === 0) return [];

  return db.select().from(orders).where(inArray(orders.id, orderIds));
}

/** Human-readable, collision-resistant. The unique index is the real guard. */
export function generateOrderNumber(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `DB-${stamp}-${random}`;
}

/**
 * Re-checks a requested delivery window against live feasibility at the
 * moment of payment — never trusts the client's earlier selection outright,
 * since a rider may have gone offline between browsing and paying. Falls
 * back to the best still-feasible window rather than failing checkout over
 * a transient rider-availability gap.
 */
async function resolvePromisedWindow(
  shopId: string,
  requested: DeliveryWindow,
): Promise<{ deliveryWindow: DeliveryWindow | null; promisedByAt: Date | null }> {
  const feasibility = await getFeasibleDeliveryWindows(shopId);
  const actual: DeliveryWindow | null = feasibility[requested]
    ? requested
    : feasibility.EXPRESS_30
      ? "EXPRESS_30"
      : feasibility.STANDARD_60
        ? "STANDARD_60"
        : feasibility.SCHEDULED
          ? "SCHEDULED"
          : null;

  if (!actual || actual === "SCHEDULED") {
    return { deliveryWindow: actual, promisedByAt: null };
  }
  const minutes = DELIVERY_WINDOW_MINUTES[actual];
  return { deliveryWindow: actual, promisedByAt: new Date(Date.now() + minutes * 60_000) };
}

async function loadAddressSnapshot(
  userId: string,
  addressId: string,
): Promise<{
  line1: string;
  line2?: string | null;
  area?: string | null;
  city: string;
  pincode: string;
  latitude?: string | null;
  longitude?: string | null;
} | null> {
  const address = await db.query.addresses.findFirst({
    where: and(eq(addresses.id, addressId), eq(addresses.userId, userId)),
  });
  if (!address) throw notFound("Address");
  return {
    line1: address.line1,
    line2: address.line2,
    area: address.area,
    city: address.city,
    pincode: address.pincode,
    latitude: address.latitude,
    longitude: address.longitude,
  };
}

/** Categorised product mix for a shop's order — used by the shop dashboard. */
export async function orderDepartments(orderId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ department: productCategories.department })
    .from(orderItems)
    .innerJoin(shopProducts, eq(orderItems.shopProductId, shopProducts.id))
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(productCategories, eq(products.categoryId, productCategories.id))
    .where(eq(orderItems.orderId, orderId));
  return rows.map((r) => r.department);
}
