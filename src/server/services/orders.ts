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
import { and, desc, eq, gte, lte, inArray, like } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { conflict, forbidden, invalidTransition, notFound, validationFailed } from "@/lib/errors";
import { canTransition } from "@/lib/state-machines";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { lineTotalPaise, sumPaise } from "@/lib/money";
import { formatShopTime, isShopOpenNow, nextOpeningAt } from "@/lib/shop-hours";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  deliveryPartners,
  orderItems,
  orderStatusHistory,
  orders,
  productCategories,
  products,
  shopProducts,
  shops,
  users,
  walletTransactions,
  type DeliveryWindow,
  type Order,
  type OrderItemFulfilment,
  type OrderStatus,
  type OrderType,
  type PaymentMethod,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { clearCartForShop, computeDeliveryFee, getCart } from "./cart";
import { consumeOnlineStock, loadPurchasableShopProduct, restockOnline } from "./catalogue";
import { COD_LIMITS, assertCodAllowedForOrder, getCodEligibility, recordCodCollection } from "./cod";
import { creditDeliveryEarnings } from "./delivery-earnings";
import { DELIVERY_WINDOW_MINUTES, getFeasibleDeliveryWindows, type DeliveryWindowFeasibility } from "./delivery-feasibility";
import { reserveSlot, slotFullError } from "./delivery-slots";
import { reserveScheduledSlot } from "./scheduled-slots";
import { acceptByFor } from "./shop-acceptance";
import { issueInvoiceForOrder } from "./invoices";
import { getOrCreateOrderGroup, referencesForGroups } from "./order-groups";
import { quoteCoupon, redeemCouponForOrder } from "./coupons";
import { getLiveOffers, priceWithOffers } from "./shop-offers";
import { rewardReferralOnDelivery } from "./customer-referrals";
import { getRule } from "./settings";
import { notifyOpenStockAlerts } from "./inventory-alerts";
import { postRetainedDeliveryFee, recordOrderFinancials } from "./finance";
import { shopServiceability, societyPartnerShopIds } from "./serviceability";
import { assertShopMayProgress } from "./shop-suspension-guard";
import { resolveAddressSociety } from "./societies";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { emitEvent } from "@/server/events/emit";
import { orderEventFor, type OrderEventPayload } from "@/server/events/catalog";
import { applyWalletMutation, refundOriginalDebit } from "./wallet";
import { checkRiskForUser } from "./risk";

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

// The order state machine lives in the shared registry (lib/state-machines.ts)
// so the event layer and this service read the same table.
export { canTransition };

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
  /**
   * GS-027: shopId → chosen time slot ("YYYY-MM-DD@HH:MM") for a SCHEDULED
   * delivery. Re-checked (hours, cut-off, places left) under a lock when the
   * order is created; a slot that filled up refuses the checkout.
   */
  scheduledSlots?: Record<string, string>;
  /** PERSONAL (default) or B2B. B2B also needs `buyerShopId` and `actorRole`. */
  orderType?: OrderType;
  /** B2B only: the approved shop, owned by the user, that is buying. */
  buyerShopId?: string | null;
  /** The caller's role — B2B is refused unless it holds ORDER_PLACE_B2B. */
  actorRole?: UserRole;
  /** WALLET (default) or COD — cash on delivery, within the COD limits (GS-030). */
  paymentMethod?: PaymentMethod;
  /**
   * Shops the customer has been warned are closed right now and chose to order
   * from anyway. A closed shop NOT listed here refuses the checkout — the
   * warning is enforced server-side, not just shown.
   */
  acknowledgeClosedShopIds?: string[];
  /** F7: an order-level coupon code. Validated and priced on the server. */
  couponCode?: string | null;
}

export interface CheckoutResult {
  orders: Order[];
  deduplicated: boolean;
  /** F6: one reference for a multi-shop checkout (null when off or single-shop). */
  parentReference?: string | null;
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
    const refs = await referencesForGroups(replayed.map((o) => o.orderGroupId));
    const parentReference = replayed.map((o) => (o.orderGroupId ? refs.get(o.orderGroupId) : null)).find(Boolean) ?? null;
    return { orders: replayed, deduplicated: true, ...(parentReference ? { parentReference } : {}) };
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

  // The delivery partner (or the shop, for a pickup) must be able to call the buyer.
  const [buyer] = await db.select({ phoneE164: users.phoneE164 }).from(users).where(eq(users.id, input.userId));
  if (!buyer?.phoneE164) {
    throw validationFailed(
      "Add your mobile number in My Profile before placing an order — the delivery partner needs it to reach you.",
      { missing: "mobile" },
    );
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

  // Closed shops: the customer must have confirmed they are happy to wait. A
  // confirmed order is placed normally and flagged, so the shop is alerted at
  // once and again when it opens (see shop-opening.ts).
  const closedShops = new Map<string, Date | null>();
  const acknowledged = new Set(input.acknowledgeClosedShopIds ?? []);
  const unconfirmed: string[] = [];
  const checkedAt = new Date();
  for (const group of purchasableGroups) {
    const [shopRow] = await db.select().from(shops).where(eq(shops.id, group.shop.id));
    if (!shopRow || isShopOpenNow(shopRow, checkedAt)) continue;
    closedShops.set(shopRow.id, nextOpeningAt(shopRow, checkedAt));
    if (!acknowledged.has(shopRow.id)) unconfirmed.push(shopRow.name);
  }
  if (unconfirmed.length > 0) {
    throw conflict(
      `${unconfirmed.join(", ")} ${unconfirmed.length === 1 ? "is" : "are"} closed right now. Confirm you want to continue — your order may be processed once the shop opens.`,
    );
  }

  const addressWithSociety = input.addressId
    ? await loadAddressSnapshot(input.userId, input.addressId)
    : null;
  // Society of the delivery address — only while the customer is still an
  // active member of a verified society (society rider rules, security, visibility).
  const orderSocietyId = addressWithSociety
    ? await resolveAddressSociety(input.userId, addressWithSociety.societyId ?? null)
    : null;
  const addressSnapshot = addressWithSociety
    ? (({ societyId: _societyId, ...rest }) => {
        void _societyId;
        return rest;
      })(addressWithSociety)
    : null;

  // GS-026: never take payment for a delivery the shop cannot make. Checked
  // per shop against the chosen address (radius, PIN, or society partner
  // shop). Orders without an address (pickup) are unchanged.
  if (addressSnapshot) {
    const partners = await societyPartnerShopIds(orderSocietyId);
    const location = {
      label: "checkout",
      pincode: addressSnapshot.pincode,
      latitude: addressSnapshot.latitude ? Number(addressSnapshot.latitude) : null,
      longitude: addressSnapshot.longitude ? Number(addressSnapshot.longitude) : null,
      source: "ADDRESS" as const,
      addressId: input.addressId ?? null,
      societyId: orderSocietyId,
    };
    for (const group of purchasableGroups) {
      const [shopRow] = await db.select().from(shops).where(eq(shops.id, group.shop.id));
      if (!shopRow?.deliveryAvailable || partners.has(shopRow.id)) continue;
      const check = shopServiceability(shopRow, location);
      if (!check.deliversHere) {
        throw validationFailed(`${shopRow.name} does not deliver to this address. ${check.reason ?? ""}`.trim());
      }
    }
  }

  // A paused shop takes no new orders at all, and a delivered order must meet
  // the shop's minimum value (pickup orders are exempt from the minimum).
  {
    const groupShops = await db
      .select()
      .from(shops)
      .where(inArray(shops.id, purchasableGroups.map((g) => g.shop.id)));
    // A personal order from a shop that delivers needs a saved delivery address.
    // Business orders and shops that only offer pickup are unchanged.
    if (orderType === "PERSONAL" && !addressSnapshot && groupShops.some((s) => s.deliveryAvailable)) {
      throw validationFailed("Add a delivery address before placing this order.", { missing: "address" });
    }
    for (const group of purchasableGroups) {
      const shopRow = groupShops.find((s) => s.id === group.shop.id);
      if (!shopRow) continue;
      if (shopRow.ordersPaused) {
        throw conflict(`${shopRow.name} is not taking new orders right now.`);
      }
      if (addressSnapshot && shopRow.deliveryAvailable && group.subtotalPaise < shopRow.minOrderPaise) {
        throw validationFailed(
          `${shopRow.name} needs a minimum order of ₹${(shopRow.minOrderPaise / 100).toFixed(0)}; your items come to ₹${(group.subtotalPaise / 100).toFixed(0)}.`,
        );
      }
    }
  }

  // GS-030: cash on delivery — personal orders to a delivery address, for a
  // customer within the COD limits. Shop opt-in and amount are checked per order.
  const paymentMethod: PaymentMethod = input.paymentMethod ?? "WALLET";
  let codMaxOrderPaise: number = COD_LIMITS.maxOrderPaise;
  if (paymentMethod === "COD") {
    if (orderType !== "PERSONAL") throw validationFailed("Business orders are paid from the wallet.");
    if (!addressSnapshot) throw validationFailed("Choose a delivery address to pay cash on delivery.");
    const eligibility = await getCodEligibility(input.userId);
    if (!eligibility.allowed) throw conflict(eligibility.reason ?? "Cash on delivery is not available.");
    codMaxOrderPaise = eligibility.maxOrderPaise;
    const codOrdersAllowed = eligibility.maxOpenOrders - eligibility.openOrders;
    if (purchasableGroups.length > codOrdersAllowed) {
      throw conflict(
        `Cash on delivery allows ${codOrdersAllowed} more open order${codOrdersAllowed === 1 ? "" : "s"} — this cart would create ${purchasableGroups.length}. Pay from your wallet instead.`,
      );
    }
  }

  const created: Order[] = [];
  let anyDeduplicated = false;

  // F7: price the coupon over the whole order (every shop together), split
  // across shops by goods value. Re-checked under a lock in each order below.
  const couponQuote = input.couponCode?.trim()
    ? await quoteCoupon(
        input.couponCode,
        input.userId,
        input.requestId,
        purchasableGroups.map((g) => ({ shopId: g.shop.id, goodsPaise: g.subtotalPaise })),
      )
    : null;

  // F6: a cart spanning several shops gets one parent reference over all its orders.
  const orderGroup =
    purchasableGroups.length > 1 && (await getRule("parentOrders")).enabled
      ? await getOrCreateOrderGroup(input.userId, input.requestId)
      : null;

  // One transaction per shop: a problem with one shop's order must not roll back
  // a sibling shop's successful order.
  for (const group of purchasableGroups) {
    const idempotencyKey = `checkout:${input.userId}:${input.requestId}:${group.shop.id}`;

    // Fast path: this shop's order was already placed under this request id
    // (found by its checkout key; older wallet orders by their debit).
    const priorOrder = await db.query.orders.findFirst({ where: eq(orders.checkoutKey, idempotencyKey) });
    if (priorOrder) {
      created.push(priorOrder);
      anyDeduplicated = true;
      continue;
    }
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

    // F5: with slot capacity on, every delivered order is booked into a slot,
    // so one placed without a chosen window gets the best open one.
    const slotsOn = addressSnapshot != null && (await getRule("deliverySlots")).enabled && (await shopDelivers(group.shop.id));
    const requestedWindow = input.deliveryWindows?.[group.shop.id] ?? (slotsOn ? "EXPRESS_30" : undefined);
    // GS-027: a scheduled delivery with a chosen time is booked into that slot
    // below; every other choice ("deliver now", scheduled without a time) is
    // resolved exactly as before.
    const chosenSlotKey =
      requestedWindow === "SCHEDULED" && addressSnapshot != null ? input.scheduledSlots?.[group.shop.id] : undefined;
    if (chosenSlotKey && !(await shopDelivers(group.shop.id))) {
      throw validationFailed(`${group.shop.name} does not deliver, so a delivery time cannot be chosen.`);
    }
    const resolvedWindow = chosenSlotKey
      ? { deliveryWindow: "SCHEDULED" as DeliveryWindow, promisedByAt: null, feasibility: null }
      : requestedWindow
        ? await resolvePromisedWindow(group.shop.id, requestedWindow)
        : { deliveryWindow: null, promisedByAt: null, feasibility: null };
    let { deliveryWindow, promisedByAt } = resolvedWindow;
    let deliverySlotKey: string | null = null;
    let scheduledSlot: { start: Date; end: Date; date: string } | null = null;
    const acceptBy = await acceptByFor(new Date(), closedShops.get(group.shop.id) ?? null);

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
      const shopOffersLive = await getLiveOffers([group.shop.id], new Date(), tx);
      for (const line of group.lines) {
        if (!line.purchasable) continue;

        const loaded = await loadPurchasableShopProduct(
          line.shopProductId,
          line.quantity,
          tx,
        );
        const quantityMilli = line.quantity * loaded.product.unitSizeMilli;
        // F8: a live shop offer lowers the unit price (the same pricing as the cart).
        const unitPricePaise =
          priceWithOffers(
            loaded.unitPricePaise,
            { shopId: group.shop.id, shopProductId: loaded.shopProduct.id, categoryId: loaded.product.categoryId },
            shopOffersLive,
          ).unitPricePaise ?? loaded.unitPricePaise;
        lines.push({
          shopProductId: loaded.shopProduct.id,
          productName: loaded.product.name,
          unit: loaded.product.unit,
          unitPricePaise,
          quantityUnits: line.quantity,
          quantityMilli,
          lineTotalPaise: lineTotalPaise(unitPricePaise, quantityMilli),
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
      const couponShare = couponQuote?.shares.find((sh) => sh.shopId === group.shop.id)?.discountPaise ?? 0;
      const discountPaise = Math.min(couponShare, subtotalPaise);
      const totalPaise = subtotalPaise + deliveryFeePaise + taxPaise - discountPaise;
      if (paymentMethod === "COD") assertCodAllowedForOrder(shopRow, totalPaise, codMaxOrderPaise);

      // GS-027: the customer's chosen time slot, re-checked under the day's lock.
      if (chosenSlotKey) {
        const booked = await reserveScheduledSlot(tx, group.shop.id, chosenSlotKey);
        deliverySlotKey = booked.slotKey;
        promisedByAt = booked.end;
        scheduledSlot = booked;
      } else if (slotsOn) {
        // F5: book a place in the window's current slot under a lock; if it filled
        // up since the customer looked, move to the next open window, else refuse.
        const feasibility = resolvedWindow.feasibility;
        if (!deliveryWindow && feasibility?.full && Object.values(feasibility.full).some(Boolean)) {
          throw slotFullError(shopRow.name);
        }
        if (deliveryWindow) {
          const order = [deliveryWindow, ...WINDOW_PREFERENCE.filter((w) => w !== deliveryWindow && feasibility?.[w])];
          let booked = false;
          for (const w of order) {
            const slot = await reserveSlot(tx, group.shop.id, w);
            if (!slot) continue;
            if (w !== deliveryWindow) {
              deliveryWindow = w;
              promisedByAt = w === "SCHEDULED" ? null : new Date(Date.now() + DELIVERY_WINDOW_MINUTES[w] * 60_000);
            }
            deliverySlotKey = slot.slotKey;
            booked = true;
            break;
          }
          if (!booked) throw slotFullError(shopRow.name);
        }
      }

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
          paymentMethod,
          placedWhileClosed: closedShops.has(group.shop.id),
          expectedOpenAt: closedShops.get(group.shop.id) ?? null,
          checkoutKey: idempotencyKey,
          societyId: orderSocietyId,
          subtotalPaise,
          deliveryFeePaise,
          taxPaise,
          totalPaise,
          deliveryWindow,
          promisedByAt,
          deliverySlotKey,
          scheduledSlotStart: scheduledSlot?.start ?? null,
          scheduledSlotEnd: scheduledSlot?.end ?? null,
          deliveryDate: scheduledSlot?.date ?? null,
          orderGroupId: orderGroup?.id ?? null,
          discountPaise,
          couponCode: couponQuote ? couponQuote.code : null,
          notes: input.notes ?? null,
        })
        .returning();

      if (couponQuote) {
        await redeemCouponForOrder(tx, {
          couponId: couponQuote.couponId,
          userId: input.userId,
          requestId: input.requestId,
          orderId: orderRow.id,
          sharePaise: discountPaise,
          orderGoodsPaise: subtotalPaise,
        });
      }

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
      // A COD order is confirmed unpaid; it is paid when the cash is collected.
      if (paymentMethod === "WALLET") {
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
      }

      const [confirmed] = await tx
        .update(orders)
        .set({
          status: "CONFIRMED",
          paidAt: paymentMethod === "WALLET" ? new Date() : null,
          // NEW-007: the shop's accept-by time (null while the rule is off).
          acceptByAt: acceptBy,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderRow.id))
        .returning();

      await tx.insert(orderStatusHistory).values({
        orderId: orderRow.id,
        previousStatus: "PENDING",
        newStatus: "CONFIRMED",
        changedBy: input.userId,
        note: paymentMethod === "WALLET" ? "Paid from wallet" : "Cash on delivery",
      });

      await recordAudit(
        {
          actorId: input.userId,
          action: AUDIT_ACTIONS.ORDER_PLACED,
          entityType: "order",
          entityId: orderRow.id,
          newValue: { orderNumber: orderRow.orderNumber, totalPaise, paymentMethod },
        },
        tx,
      );
      // Event layer: the placed order on the event log. The customer and shop
      // notifications below stay where they are (they depend on opening hours).
      await emitEvent(
        {
          type: "order.placed",
          subjectId: orderRow.id,
          orderId: orderRow.id,
          transition: { from: "PENDING", to: "CONFIRMED" },
          actor: { id: input.userId, role: input.actorRole ?? "CUSTOMER" },
          payload: {
            orderId: orderRow.id,
            orderNumber: orderRow.orderNumber,
            buyerId: input.userId,
            shopOwnerId: shopRow.ownerId,
            shopName: shopRow.name,
          },
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
      if (closedShops.has(group.shop.id)) {
        // Alert 1 of 2: immediately, even though the shop is closed. Alert 2
        // goes out once when the shop opens (sendShopOpeningAlerts).
        const opensAt = closedShops.get(group.shop.id);
        await notify(
          {
            userId: shopRow.ownerId,
            type: NOTIFICATION_TYPES.SHOP_ORDER_WHILE_CLOSED,
            title: "New order while your shop is closed",
            body: `Order ${orderRow.orderNumber} — ${lines.length} item${lines.length === 1 ? "" : "s"}, ₹${(totalPaise / 100).toFixed(2)}${paymentMethod === "COD" ? " (cash on delivery)" : ""} — was placed while your shop is closed. The customer chose to wait; you will get another alert when your shop opens.`,
            actionUrl: "/shop/orders",
          },
          tx,
        );
        await notify(
          {
            userId: input.userId,
            type: NOTIFICATION_TYPES.ORDER_QUEUED_SHOP_CLOSED,
            title: "Order placed — shop is closed now",
            body: `Your order ${orderRow.orderNumber} was sent to ${shopRow.name}. The shop is closed right now, so it may be processed once it opens${opensAt ? ` (${formatShopTime(opensAt)})` : ""}.`,
            actionUrl: "/orders",
          },
          tx,
        );
      } else {
        await notify(
          {
            userId: shopRow.ownerId,
            type: NOTIFICATION_TYPES.SHOP_NEW_ORDER,
            title: "New order",
            body: `Order ${orderRow.orderNumber} — ${lines.length} item${lines.length === 1 ? "" : "s"}, ₹${(totalPaise / 100).toFixed(2)}${paymentMethod === "COD" ? " (cash on delivery)" : ""}.`,
            actionUrl: "/shop/orders",
          },
          tx,
        );
      }

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

  // Event layer: the per-order risk rules run now, at placement, not at the next
  // hourly scan. After commit and never throwing — a check must not block an order.
  if (created.length > 0) await checkRiskForUser(input.userId, "ORDER_PLACED");

  return { orders: created, deduplicated: anyDeduplicated, ...(orderGroup ? { parentReference: orderGroup.reference } : {}) };
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

/**
 * What a status or fulfilment action answers with: the order's new state.
 * The row itself carries the customer's delivery address, ids and checkout
 * key, which the shop or operator acting on it never needs back.
 */
export function toOrderStatusView(order: Order): Pick<Order, "id" | "orderNumber" | "status"> {
  return { id: order.id, orderNumber: order.orderNumber, status: order.status };
}

export async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  actor: { id: string; role: UserRole },
  note?: string,
  client?: DbClient,
  /** Event layer: extra facts for the order event's notifications (e.g. the rider's name). */
  event?: Pick<OrderEventPayload, "riderUserId" | "riderName" | "reason">,
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
    // Suspended shops cannot take new orders or move orders under review.
    await assertShopMayProgress(tx, order, newStatus, actor);

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

    // GS-030: a cash-on-delivery order becomes paid when it is delivered —
    // before the finance snapshot, which only covers paid orders.
    if (newStatus === "DELIVERED" && order.paymentMethod === "COD") {
      await recordCodCollection(order, actor.id, tx);
    }
    // Slice 6: snapshot the order's GMV / commission / shop payable the moment
    // it is delivered, in the same transaction (idempotent).
    if (newStatus === "DELIVERED") {
      await recordOrderFinancials(orderId, tx);
      // F11: a referred customer's first delivered order rewards both sides.
      // Under a savepoint, so a problem here can never block the delivery.
      await tx
        .transaction((sp) => rewardReferralOnDelivery(orderId, sp))
        .catch((error) => console.error("[referrals] reward check failed for order", orderId, error));
      // NEW-007: the shop's invoice is issued at delivery (rule invoicing).
      // Its own savepoint, so a problem here never blocks the delivery.
      await issueInvoiceForOrder(orderId, tx).catch((error) =>
        console.error("[invoices] issue failed for order", orderId, error),
      );
    }
    // Phase 2: invite the customer to rate the shop and rider (GS-059/060).
    if (newStatus === "DELIVERED") {
      await notify(
        {
          userId: order.userId,
          type: NOTIFICATION_TYPES.RATING_REQUESTED,
          title: "How was your order?",
          body: `Rate order ${order.orderNumber} — your rating helps other customers and the shop.`,
          actionUrl: "/orders",
          dedupeKey: `rating-requested:${orderId}`,
        },
        tx,
      );
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

    // Event layer: every order status change is one event — checked against
    // the order state machine, logged in domain_events, and the customer and
    // shop told now (catalog.ts decides who hears what). Covers a direct
    // shop/operator change and the rider flow in delivery-assignment.ts alike,
    // since both come through this function (DEF-02).
    const [shop] = await tx
      .select({ ownerId: shops.ownerId, name: shops.name })
      .from(shops)
      .where(eq(shops.id, order.shopId));
    await emitEvent(
      {
        type: orderEventFor(newStatus),
        subjectId: orderId,
        orderId,
        transition: { from: order.status, to: newStatus },
        actor,
        payload: {
          orderId,
          orderNumber: order.orderNumber,
          buyerId: order.userId,
          shopOwnerId: shop?.ownerId ?? null,
          shopName: shop?.name ?? "the shop",
          reassigned: newStatus === "READY" && order.status === "ASSIGNED",
          reason: note ?? null,
          ...event,
        },
      },
      tx,
    );

    return updated;
  };
  return client ? run(client) : db.transaction(run);
}

export interface CancelOrderOptions {
  /**
   * NEW-007: cancel only if the order is still in this status (checked under
   * the row lock) — the acceptance-timeout sweep uses it so a shop accepting
   * at the same moment always wins.
   */
  onlyIfStatus?: OrderStatus;
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
  /** null = the system (e.g. the shop-acceptance timeout), recorded without a user. */
  actor: { id: string; role: UserRole } | null,
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

    if (options.onlyIfStatus && order.status !== options.onlyIfStatus) {
      throw conflict(`This order is now ${ORDER_STATUS_LABELS[order.status].toLowerCase()} and was not cancelled.`);
    }
    if (!canTransition(order.status, "CANCELLED")) {
      throw invalidTransition(ORDER_STATUS_LABELS[order.status], "Cancelled");
    }

    // D10: a customer cancelling their own order is blocked while the shop is
    // actively assembling it — there is no clean undo for picked/packed work,
    // so only the shop or an operator may cancel from here. Does not apply to
    // a shop/operator-privileged cancel, which stays unrestricted.
    // Rule `cancellation.customerMayCancelUntil` = PREPARING opens ACCEPTED and
    // PREPARING (before packing) to the customer too, with the same full refund.
    const beforePacking = (["ACCEPTED", "PREPARING"] as OrderStatus[]).includes(order.status);
    const customerCancelBeforePacking =
      Boolean(options.selfService) &&
      beforePacking &&
      (await getRule("cancellation")).customerMayCancelUntil === "PREPARING";
    if (
      options.selfService &&
      !customerCancelBeforePacking &&
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
      changedBy: actor?.id ?? null,
      note: reason,
    });

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
          actor?.id ?? null,
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
    let cancelledRiderUserId: string | null = null;
    if (activeDelivery) {
      const wasPickedUp = activeDelivery.pickedUpAt != null;
      const [rider] = await tx
        .select({ userId: deliveryPartners.userId })
        .from(deliveryPartners)
        .where(eq(deliveryPartners.id, activeDelivery.deliveryPartnerId));
      cancelledRiderUserId = rider?.userId ?? null;
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

    // Event layer: the cancellation as one event. The customer hears when
    // someone else cancelled (DEF-02); the shop when support did, or the
    // customer after the shop had started (D6); a rider who had the order is
    // told to stop. A customer cancelling their own order is not told about it.
    const [shopRow] = await tx
      .select({ ownerId: shops.ownerId, name: shops.name })
      .from(shops)
      .where(eq(shops.id, order.shopId));
    await emitEvent(
      {
        type: "order.cancelled",
        subjectId: orderId,
        orderId,
        transition: { from: order.status, to: "CANCELLED" },
        actor: actor ?? { id: null, role: null },
        payload: {
          orderId,
          orderNumber: order.orderNumber,
          buyerId: order.userId,
          shopOwnerId: shopRow?.ownerId ?? null,
          shopName: shopRow?.name ?? "the shop",
          riderUserId: cancelledRiderUserId,
          reason,
          cancelledBy: !actor
            ? "SYSTEM"
            : actor.id === order.userId
              ? "CUSTOMER"
              : actor.role === "OPERATOR" || actor.role === "ADMIN"
                ? "SUPPORT"
                : "SHOP",
          beforePacking: customerCancelBeforePacking,
        },
      },
      tx,
    );

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
          createdBy: actor?.id ?? null,
          amountPaise: refundAmountPaise,
        },
        tx,
      );
      // D10: the delivery fee that was NOT refunded is platform revenue.
      if (goodsOnlyRefund) await postRetainedDeliveryFee(order, tx);
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
        changedBy: actor?.id ?? null,
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

/** C3: placed directly and not yet delivered, cancelled or refunded. */
const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  "CONFIRMED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
];

export interface OpenOrderForCheckout {
  id: string;
  orderNumber: string;
  shopId: string;
  shopName: string;
  orderType: OrderType;
  status: OrderStatus;
  statusLabel: string;
  totalPaise: number;
  createdAt: Date;
  /** The customer may cancel it themselves now (D10 + rule cancellation); otherwise they contact the shop. */
  customerMayCancel: boolean;
}

/**
 * C3 (rule openOrderCheck): the customer's open orders to show before they
 * pay for a new one. Empty when the rule is off. Subscription orders are left
 * out — they recur by design.
 */
export async function listOpenOrdersForCheckout(
  userId: string,
  cartShopIds: readonly string[],
): Promise<OpenOrderForCheckout[]> {
  const rule = await getRule("openOrderCheck");
  if (!rule.enabled) return [];
  if (rule.scope === "SAME_SHOP" && cartShopIds.length === 0) return [];
  const { customerMayCancelUntil } = await getRule("cancellation");
  const cancellable: readonly OrderStatus[] =
    customerMayCancelUntil === "PREPARING"
      ? ["CONFIRMED", "ACCEPTED", "PREPARING", "PICKED_UP", "OUT_FOR_DELIVERY"]
      : ["CONFIRMED", "PICKED_UP", "OUT_FOR_DELIVERY"];
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopId: orders.shopId,
      shopName: shops.name,
      orderType: orders.orderType,
      status: orders.status,
      totalPaise: orders.totalPaise,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.source, "DIRECT"),
        inArray(orders.status, [...OPEN_ORDER_STATUSES]),
        ...(rule.scope === "SAME_SHOP" ? [inArray(orders.shopId, [...cartShopIds])] : []),
      ),
    )
    .orderBy(desc(orders.createdAt))
    .limit(10);
  return rows.map((r) => ({
    ...r,
    statusLabel: ORDER_STATUS_LABELS[r.status],
    customerMayCancel: cancellable.includes(r.status),
  }));
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
  // COD orders have no wallet debit — they are found by their checkout key.
  const keyed = await db
    .select({ id: orders.id })
    .from(orders)
    .where(like(orders.checkoutKey, `${prefix}%`));

  const orderIds = [
    ...new Set([
      ...priorTxns.map((t) => t.orderId).filter((id): id is string => id !== null),
      ...keyed.map((o) => o.id),
    ]),
  ];
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
): Promise<{ deliveryWindow: DeliveryWindow | null; promisedByAt: Date | null; feasibility: DeliveryWindowFeasibility }> {
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
    return { deliveryWindow: actual, promisedByAt: null, feasibility };
  }
  const minutes = DELIVERY_WINDOW_MINUTES[actual];
  return { deliveryWindow: actual, promisedByAt: new Date(Date.now() + minutes * 60_000), feasibility };
}

const WINDOW_PREFERENCE: DeliveryWindow[] = ["EXPRESS_30", "STANDARD_60", "SCHEDULED"];

async function shopDelivers(shopId: string): Promise<boolean> {
  const [row] = await db.select({ deliveryAvailable: shops.deliveryAvailable }).from(shops).where(eq(shops.id, shopId));
  return row?.deliveryAvailable ?? false;
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
  landmark?: string | null;
  deliveryInstructions?: string | null;
  societyId?: string | null;
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
    landmark: address.landmark,
    deliveryInstructions: address.deliveryInstructions,
    societyId: address.societyId,
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

export interface MonitoredOrder {
  id: string;
  orderNumber: string;
  shopName: string;
  customerName: string | null;
  status: OrderStatus;
  totalPaise: number;
  createdAt: Date;
  riderName: string | null;
  deliveryStatus: string | null;
  /** GA-005: set when the rider carries this order in a batched trip. */
  tripId?: string | null;
  /** NEW-007: links for a delivered order. */
  invoiceUrl?: string | null;
  proofPhotoUrl?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDay(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Staff order-monitoring list. Filters come from the URL, so bad values are ignored rather than thrown. */
export async function listOrdersForMonitoring(filters: {
  status?: string;
  shopId?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<MonitoredOrder[]> {
  const conditions = [];

  if (filters.status && filters.status in ORDER_STATUS_LABELS) {
    conditions.push(eq(orders.status, filters.status as OrderStatus));
  }
  if (filters.shopId && UUID_RE.test(filters.shopId)) {
    conditions.push(eq(orders.shopId, filters.shopId));
  }
  const dateFrom = parseDay(filters.dateFrom);
  if (dateFrom) conditions.push(gte(orders.createdAt, dateFrom));
  const dateTo = parseDay(filters.dateTo);
  if (dateTo) {
    dateTo.setHours(23, 59, 59, 999);
    conditions.push(lte(orders.createdAt, dateTo));
  }

  const riderUser = alias(users, "rider_user");

  return db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopName: shops.name,
      customerName: users.name,
      status: orders.status,
      totalPaise: orders.totalPaise,
      createdAt: orders.createdAt,
      riderName: riderUser.name,
      deliveryStatus: deliveryOrders.status,
      tripId: deliveryOrders.tripId,
    })
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .innerJoin(users, eq(orders.userId, users.id))
    // Only the live assignment — rejected/cancelled offers would duplicate rows.
    .leftJoin(
      deliveryOrders,
      and(
        eq(deliveryOrders.orderId, orders.id),
        inArray(deliveryOrders.status, ["OFFERED", "ACCEPTED", "PICKED_UP", "DELIVERED", "FAILED"]),
      ),
    )
    .leftJoin(deliveryPartners, eq(deliveryOrders.deliveryPartnerId, deliveryPartners.id))
    .leftJoin(riderUser, eq(deliveryPartners.userId, riderUser.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(100);
}

export function orderStatusOptions(): Array<{ value: string; label: string }> {
  return Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label }));
}

export async function listShopOptions(): Promise<Array<{ id: string; name: string }>> {
  return db.select({ id: shops.id, name: shops.name }).from(shops).orderBy(shops.name).limit(500);
}
