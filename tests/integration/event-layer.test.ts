/**
 * Event layer (docs/event-driven-2026-10): every order and delivery event
 * changes status, writes a domain_events row and notifies the right people in
 * the same request — and never twice.
 */
import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 150_000, hookTimeout: 90_000 });

import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, domainEvents, notifications, orders, riderSearches } from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { addToCart } from "@/server/services/cart";
import {
  acceptDeliveryOffer,
  alertOverdueRiderSearches,
  dispatchReadyOrder,
  markDeliveryFailed,
  markDelivered,
  markPickedUp,
  recordDeliveryLocation,
  rejectDeliveryOffer,
  startDelivery,
} from "@/server/services/delivery-assignment";
import { acceptOrder, markOrderReady, rejectOrder, startPicking } from "@/server/services/fulfilment";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { cancelOrder, checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { runShopAcceptanceSweep } from "@/server/services/shop-acceptance";
import { getWalletByUserId } from "@/server/services/wallet";
import {
  createCategory,
  createDeliveryPartner,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
  setDeliveryCode,
} from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

const SHOP_LAT = 18.5;
const SHOP_LNG = 73.85;

const notesFor = (userId: string, type?: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), type ? eq(notifications.type, type) : undefined));

const eventsFor = (orderId: string) =>
  db.select().from(domainEvents).where(eq(domainEvents.orderId, orderId)).orderBy(asc(domainEvents.createdAt));

async function placedOrder(options: { acceptMinutes?: number } = {}) {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const operator = await createUser({ role: "OPERATOR" });
  const admin = await createUser({ role: "ADMIN" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { status: "APPROVED", latitude: SHOP_LAT, longitude: SHOP_LNG });
  const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineSaleEnabled: true });
  if (options.acceptMinutes) {
    await setRule("shopAcceptance", { enabled: true, acceptMinutes: options.acceptMinutes }, { id: admin.id, role: "ADMIN" });
  }
  await addToCart(customer.id, shopProduct.id, 1);
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: await deliveryAddressId(customer.id),
  });
  const [order] = await db
    .update(orders)
    .set({
      deliveryAddressSnapshot: { line1: "1 Test Road", city: "Pune", pincode: "411001", latitude: "18.52", longitude: "73.85" },
    })
    .where(eq(orders.id, created[0].id))
    .returning();
  return {
    order,
    customer,
    owner,
    operator,
    admin,
    shopActor: { id: owner.id, role: "SHOP_OWNER" as const },
  };
}

async function rider(name = "Ravi Rider", latOffset = 0) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, {
    isOnline: true,
    latitude: SHOP_LAT + latOffset,
    longitude: SHOP_LNG,
    operatingRadiusKm: 20,
  });
  await db.update(deliveryPartners).set({ fullName: name }).where(eq(deliveryPartners.id, partner.id));
  return { user, partner, actor: { id: user.id, role: "DELIVERY_PARTNER" as const } };
}

async function readyOrder() {
  const setup = await placedOrder();
  await acceptOrder(setup.order.id, setup.shopActor);
  await startPicking(setup.order.id, setup.shopActor);
  return setup;
}

describe("shop acceptance", () => {
  it("accepting notifies the customer at once and logs the event; a repeated click is refused and notifies nobody again", async () => {
    const { order, customer, shopActor } = await placedOrder();
    await acceptOrder(order.id, shopActor);

    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_ACCEPTED)).toHaveLength(1);
    const events = await eventsFor(order.id);
    expect(events.map((e) => e.type)).toEqual(["order.placed", "order.accepted"]);
    expect(events[1]).toMatchObject({ fromStatus: "CONFIRMED", toStatus: "ACCEPTED", actorId: shopActor.id, notified: 1 });

    await expect(acceptOrder(order.id, shopActor)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_ACCEPTED)).toHaveLength(1);
    expect(await eventsFor(order.id)).toHaveLength(2);
  });

  it("rejecting cancels with the reason, refunds in full (delivery fee included) and tells the customer", async () => {
    const { order, customer, shopActor } = await placedOrder();
    const before = (await getWalletByUserId(customer.id))!;
    await rejectOrder(order.id, shopActor, "Out of milk today");

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after.status).toBe("REFUNDED");
    expect((await getWalletByUserId(customer.id))!.balancePaise).toBe(before.balancePaise + order.totalPaise);
    const [note] = await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_CANCELLED);
    expect(note.body).toContain("Out of milk today");
    expect((await eventsFor(order.id)).map((e) => e.type)).toContain("order.cancelled");
  });

  it("timeout CANCEL (default): the sweep cancels after X minutes, the customer and the shop are told once", async () => {
    const { order, customer, owner } = await placedOrder({ acceptMinutes: 30 });
    expect(order.acceptByAt!.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    const later = new Date(order.acceptByAt!.getTime() + 60_000);
    expect(await runShopAcceptanceSweep(later)).toMatchObject({ cancelled: 1 });
    expect(await runShopAcceptanceSweep(later)).toMatchObject({ cancelled: 0 });
    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_CANCELLED)).toHaveLength(1);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_ORDER_TIMED_OUT)).toHaveLength(1);
  });

  it("timeout ESCALATE: support and the shop are alerted once and the order stays with the shop", async () => {
    const { order, owner, operator, admin } = await placedOrder({ acceptMinutes: 30 });
    await setRule("shopAcceptance", { enabled: true, acceptMinutes: 30, onTimeout: "ESCALATE" }, { id: admin.id, role: "ADMIN" });
    const later = new Date(order.acceptByAt!.getTime() + 60_000);
    expect(await runShopAcceptanceSweep(later)).toMatchObject({ escalated: 1, cancelled: 0 });
    expect(await runShopAcceptanceSweep(later)).toMatchObject({ escalated: 0 });

    const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(after.status).toBe("CONFIRMED");
    expect(after.acceptEscalatedAt).not.toBeNull();
    expect(await notesFor(operator.id, NOTIFICATION_TYPES.SUPPORT_ACCEPT_OVERDUE)).toHaveLength(1);
    expect(await notesFor(admin.id, NOTIFICATION_TYPES.SUPPORT_ACCEPT_OVERDUE)).toHaveLength(1);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_ACCEPT_ESCALATED)).toHaveLength(1);
  });
});

describe("delivery events", () => {
  it("each step updates both statuses and notifies the customer and the shop at once", async () => {
    const { order, customer, owner, shopActor } = await readyOrder();
    const ravi = await rider("Ravi Rider");

    await markOrderReady(order.id, shopActor); // starts the rider search immediately
    const [offer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(offer.status).toBe("OFFERED");
    expect(await notesFor(ravi.user.id, NOTIFICATION_TYPES.DELIVERY_OFFERED)).toHaveLength(1);
    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_RIDER_SEARCH)).toHaveLength(1);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_RIDER_SEARCH_STARTED)).toHaveLength(1);

    await acceptDeliveryOffer(offer.id, ravi.user.id);
    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_ASSIGNED)).toHaveLength(1);
    const [assigned] = await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_RIDER_ASSIGNED);
    expect(assigned.body).toContain("Ravi Rider");

    const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    await markPickedUp(offer.id, ravi.actor, accepted.pickupCode!);
    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_PICKED_UP)).toHaveLength(1);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_ORDER_PICKED_UP)).toHaveLength(1);

    await startDelivery(offer.id, ravi.actor);
    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_OUT_FOR_DELIVERY)).toHaveLength(1);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_ORDER_OUT_FOR_DELIVERY)).toHaveLength(1);

    await markDelivered(offer.id, ravi.actor, await setDeliveryCode(offer.id));
    expect(await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_DELIVERED)).toHaveLength(1);
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_ORDER_DELIVERED)).toHaveLength(1);

    const types = (await eventsFor(order.id)).map((e) => e.type);
    expect(types).toEqual([
      "order.placed",
      "order.accepted",
      "order.preparing",
      "order.ready",
      "delivery.offered",
      "delivery.accepted",
      "order.assigned",
      "delivery.picked_up",
      "order.picked_up",
      "delivery.started",
      "order.out_for_delivery",
      "delivery.delivered",
      "order.delivered",
    ]);
  });

  it("a rider declining tells the shop and the next rider is offered the order at once", async () => {
    const { order, owner, shopActor } = await readyOrder();
    const near = await rider("Near Rider", 0);
    const far = await rider("Far Rider", 0.02);
    await markOrderReady(order.id, shopActor);
    const [offer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(offer.deliveryPartnerId).toBe(near.partner.id);

    await rejectDeliveryOffer(offer.id, near.user.id, "Too far");
    const [reoffer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(reoffer).toMatchObject({ status: "OFFERED", deliveryPartnerId: far.partner.id });
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_RIDER_DECLINED)).toHaveLength(1);
    expect(await notesFor(far.user.id, NOTIFICATION_TYPES.DELIVERY_OFFERED)).toHaveLength(1);
    // The search notice went out once for the order, not once per rider.
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_RIDER_SEARCH_STARTED)).toHaveLength(1);
  });

  it("a failed drop tells the customer and the shop with the reason", async () => {
    const { order, customer, owner, shopActor } = await readyOrder();
    const ravi = await rider();
    await markOrderReady(order.id, shopActor);
    const [offer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    await acceptDeliveryOffer(offer.id, ravi.user.id);
    const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    await markPickedUp(offer.id, ravi.actor, accepted.pickupCode!);
    await markDeliveryFailed(offer.id, ravi.actor, "Customer not at home");

    const [buyerNote] = await notesFor(customer.id, NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED);
    const [shopNote] = await notesFor(owner.id, NOTIFICATION_TYPES.ORDER_DELIVERY_FAILED);
    expect(buyerNote.body).toContain("Customer not at home");
    expect(shopNote.body).toContain("Customer not at home");
  });

  it("cancelling an order a rider has accepted tells the rider", async () => {
    const { order, operator, shopActor } = await readyOrder();
    const ravi = await rider();
    await markOrderReady(order.id, shopActor);
    const [offer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    await acceptDeliveryOffer(offer.id, ravi.user.id);
    await cancelOrder(order.id, { id: operator.id, role: "OPERATOR" }, "Customer asked support to cancel");
    expect(await notesFor(ravi.user.id, NOTIFICATION_TYPES.DELIVERY_CANCELLED)).toHaveLength(1);
  });

  it("no rider accepted within Y minutes: support is alerted once", async () => {
    const { order, operator, shopActor } = await readyOrder();
    await markOrderReady(order.id, shopActor); // nobody online: the search starts and finds no one
    await dispatchReadyOrder(order.id, { id: null, role: null }, "SWEEP");
    const later = new Date(Date.now() + 31 * 60_000);
    expect(await alertOverdueRiderSearches(later)).toBe(1);
    expect(await alertOverdueRiderSearches(later)).toBe(0);
    expect(await notesFor(operator.id, NOTIFICATION_TYPES.SUPPORT_RIDER_UNASSIGNED)).toHaveLength(1);
    const [search] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, order.id));
    expect(search.supportAlertedAt).not.toBeNull();
  });
});

describe("live tracking", () => {
  it("only the rider holding the delivery posts, only from the start of the drop until it is delivered", async () => {
    const { order, shopActor } = await readyOrder();
    const ravi = await rider();
    const stranger = await rider("Someone Else", 0.05);
    await markOrderReady(order.id, shopActor);
    const [offer] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    await acceptDeliveryOffer(offer.id, ravi.user.id);
    const [accepted] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, offer.id));
    await markPickedUp(offer.id, ravi.actor, accepted.pickupCode!);

    const lastFix = async () =>
      (await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, ravi.partner.id)))[0].lastLocationLatitude;

    await expect(recordDeliveryLocation(offer.id, stranger.user.id, 18.51, 73.85)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Picked up, drop not started: nothing stored.
    expect(await recordDeliveryLocation(offer.id, ravi.user.id, 18.51, 73.85)).toMatchObject({ sharing: false });
    expect(await lastFix()).not.toBe("18.51");

    await startDelivery(offer.id, ravi.actor);
    expect(await recordDeliveryLocation(offer.id, ravi.user.id, 18.51, 73.85)).toMatchObject({ sharing: true, nextPingSeconds: 5 });
    expect(Number(await lastFix())).toBeCloseTo(18.51, 5);

    await markDelivered(offer.id, ravi.actor, await setDeliveryCode(offer.id));
    expect(await recordDeliveryLocation(offer.id, ravi.user.id, 18.6, 73.9)).toMatchObject({ sharing: false });
    expect(Number(await lastFix())).toBeCloseTo(18.51, 5);
  });
});

describe("emitEvent", () => {
  it("refuses a move the state machine does not allow and writes nothing", async () => {
    const { order, shopActor } = await placedOrder();
    await expect(
      db.transaction((tx) =>
        emitEvent(
          {
            type: "order.delivered",
            subjectId: order.id,
            orderId: order.id,
            transition: { from: "CONFIRMED", to: "DELIVERED" },
            actor: shopActor,
            payload: { orderId: order.id, orderNumber: order.orderNumber, buyerId: order.userId, shopOwnerId: null, shopName: "x" },
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect((await eventsFor(order.id)).map((e) => e.type)).toEqual(["order.placed"]);
  });

  it("an idempotency key makes the event — and its notifications — happen once", async () => {
    const { order, owner } = await placedOrder();
    const input = {
      type: "order.accept_reminder" as const,
      subjectId: order.id,
      orderId: order.id,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        buyerId: order.userId,
        shopOwnerId: owner.id,
        shopName: "Shop",
        minutes: 5,
      } satisfies Parameters<typeof emitEvent<"order.accept_reminder">>[0]["payload"],
      idempotencyKey: `test-reminder:${order.id}`,
    };
    const first = await emitEvent(input);
    const second = await emitEvent(input);
    expect(first).toMatchObject({ duplicate: false, notified: 1 });
    expect(second).toMatchObject({ duplicate: true, notified: 0 });
    expect(await notesFor(owner.id, NOTIFICATION_TYPES.SHOP_ACCEPT_REMINDER)).toHaveLength(1);
  });
});
