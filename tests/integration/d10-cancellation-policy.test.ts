/**
 * D10 — order cancellation policy: characterization tests.
 *
 * The source of truth is decision D10 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md,
 * DEF-08, resolved 2026-09-22) plus its Slice 3/4 extension recorded in
 * cancelOrder's own comment:
 *
 *   CONFIRMED                       customer may cancel — full refund
 *   ACCEPTED/PREPARING/READY/ASSIGNED  customer blocked — shop/operator only
 *   PICKED_UP / OUT_FOR_DELIVERY    customer may cancel — GOODS-ONLY refund,
 *                                   delivery fee kept, rider still paid
 *   shop / operator cancellation    unrestricted, full refund at every status
 *
 * Money moves only along amounts an order already carries; these tests pin
 * that behaviour so a later change cannot alter it silently. Runs against the
 * real database and the real services (no mocks).
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartnerEarnings,
  financeLedgerEntries,
  orderFinancials,
  orders,
  shopProducts,
  wallets,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  markPickedUp,
  startDelivery,
} from "@/server/services/delivery-assignment";
import { acceptOrder, removeItem, startPicking } from "@/server/services/fulfilment";
import { cancelOrder, checkout, updateOrderStatus } from "@/server/services/orders";
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
} from "../helpers/fixtures";

beforeEach(resetDatabase);

const START_BALANCE = 500_000;
const GOODS = 7000;
const FEE = 1000;

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;
const stockOf = async (shopProductId: string) =>
  (await db.query.shopProducts.findFirst({ where: eq(shopProducts.id, shopProductId) }))!.onlineStock;
const statusOf = async (orderId: string) =>
  (await db.query.orders.findFirst({ where: eq(orders.id, orderId) }))!.status;

/** A dairy with a ₹10 delivery fee; the customer buys one ₹70 milk (optionally also a ₹30 curd). */
async function setup(options: { twoLines?: boolean } = {}) {
  const { user: customer } = await createUserWithWallet({ balancePaise: START_BALANCE });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { deliveryFeePaise: FEE, latitude: 0, longitude: 0 });
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: GOODS, onlineStock: 50 });
  await addToCart(customer.id, milkSp.id, 1);

  let curdSp: typeof milkSp | null = null;
  if (options.twoLines) {
    const curd = await createProduct(category.id, { name: "Curd", unit: "kg" });
    curdSp = await createShopProduct(shop.id, curd.id, { onlinePricePaise: 3000, onlineStock: 20 });
    await addToCart(customer.id, curdSp.id, 1);
  }
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: await deliveryAddressId(customer.id),
  });
  return {
    customer: { id: customer.id, role: "CUSTOMER" as const },
    owner: { id: owner.id, role: "SHOP_OWNER" as const },
    shopProductId: milkSp.id,
    curdShopProductId: curdSp?.id ?? null,
    order: created[0],
  };
}

type Actors = Awaited<ReturnType<typeof setup>>;

const toReady = async ({ order, owner }: Actors) => {
  await updateOrderStatus(order.id, "PREPARING", owner);
  await updateOrderStatus(order.id, "READY", owner);
};

/** Puts an approved rider on the order (order becomes ASSIGNED). */
async function assignRider(s: Actors) {
  await toReady(s);
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  await createDeliveryPartner(riderUser.id, {
    status: "APPROVED",
    isOnline: true,
    latitude: 0,
    longitude: 0,
    operatingRadiusKm: 50,
  });
  const offer = await assignNearestPartner(s.order.id, s.owner);
  await acceptDeliveryOffer(offer.id, riderUser.id);
  return { deliveryOrderId: offer.id, rider: { id: riderUser.id, role: "DELIVERY_PARTNER" as const } };
}

async function pickUp(s: Actors) {
  const d = await assignRider(s);
  const row = (await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.id, d.deliveryOrderId) }))!;
  await markPickedUp(d.deliveryOrderId, d.rider, row.pickupCode!);
  return d;
}

const earningFor = (deliveryOrderId: string) =>
  db.query.deliveryPartnerEarnings.findFirst({ where: eq(deliveryPartnerEarnings.deliveryOrderId, deliveryOrderId) });
const deliveryRow = (id: string) => db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.id, id) });
const retainedFeeEntries = (orderId: string) =>
  db
    .select()
    .from(financeLedgerEntries)
    .where(and(eq(financeLedgerEntries.orderId, orderId), eq(financeLedgerEntries.entryType, "DELIVERY_FEE")));

describe("D10 — customer cancellation", () => {
  it("CONFIRMED: full refund, stock returned, nothing settled, no rider paid, no fee retained", async () => {
    const s = await setup();
    expect(s.order.totalPaise).toBe(GOODS + FEE);
    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE - (GOODS + FEE));
    expect(await stockOf(s.shopProductId)).toBe(49);

    const cancelled = await cancelOrder(s.order.id, s.customer, "Changed my mind", { selfService: true });

    expect(cancelled.status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE); // goods + delivery fee
    expect(await stockOf(s.shopProductId)).toBe(50); // inventory implication: the unit is back
    expect(await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, s.order.id))).toHaveLength(0);
    expect(await db.select().from(deliveryPartnerEarnings)).toHaveLength(0);
    expect(await retainedFeeEntries(s.order.id)).toHaveLength(0);
  });

  it("cancelling a second time is refused and never refunds twice", async () => {
    const s = await setup();
    await cancelOrder(s.order.id, s.customer, "first", { selfService: true });
    await expect(cancelOrder(s.order.id, s.customer, "second", { selfService: true })).rejects.toThrow();
    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE);
  });

  for (const status of ["ACCEPTED", "PREPARING", "READY"] as const) {
    it(`${status}: the customer is blocked (contact the shop); nothing changes`, async () => {
      const s = await setup();
      if (status === "ACCEPTED") await acceptOrder(s.order.id, s.owner);
      if (status === "PREPARING") await updateOrderStatus(s.order.id, "PREPARING", s.owner);
      if (status === "READY") await toReady(s);
      const before = await balanceOf(s.customer.id);

      await expect(cancelOrder(s.order.id, s.customer, "no thanks", { selfService: true })).rejects.toThrow(
        /already being prepared/i,
      );

      expect(await statusOf(s.order.id)).toBe(status);
      expect(await balanceOf(s.customer.id)).toBe(before);
      expect(await stockOf(s.shopProductId)).toBe(49);
    });
  }

  it("ASSIGNED (rider accepted): the customer is blocked and the rider's assignment is untouched", async () => {
    const s = await setup();
    const d = await assignRider(s);
    expect(await statusOf(s.order.id)).toBe("ASSIGNED");

    await expect(cancelOrder(s.order.id, s.customer, "no thanks", { selfService: true })).rejects.toThrow(
      /already being prepared/i,
    );

    expect((await deliveryRow(d.deliveryOrderId))?.status).toBe("ACCEPTED");
    expect(await statusOf(s.order.id)).toBe("ASSIGNED");
  });

  it("PICKED_UP: goods-only refund, delivery fee kept and journaled, rider still paid, stock returned", async () => {
    const s = await setup();
    const d = await pickUp(s);
    expect(await statusOf(s.order.id)).toBe("PICKED_UP");
    const before = await balanceOf(s.customer.id);

    const cancelled = await cancelOrder(s.order.id, s.customer, "no thanks", { selfService: true });

    expect(cancelled.status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(before + GOODS); // the ₹10 fee is kept
    expect((await deliveryRow(d.deliveryOrderId))?.status).toBe("CANCELLED");
    expect((await earningFor(d.deliveryOrderId))?.totalPaise).toBeGreaterThan(0); // rider paid for the trip
    expect(await stockOf(s.shopProductId)).toBe(50);

    // The retained fee is platform revenue, journaled exactly once.
    const fee = await retainedFeeEntries(s.order.id);
    expect(fee).toHaveLength(1);
    expect(fee[0]).toMatchObject({ entityType: "PLATFORM", direction: "CREDIT", amountPaise: FEE });
    // A cancelled order never becomes a shop settlement line.
    expect(await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, s.order.id))).toHaveLength(0);
  });

  it("OUT_FOR_DELIVERY: same goods-only rule, and the rider's earning is journaled against the platform", async () => {
    const s = await setup();
    const d = await pickUp(s);
    await startDelivery(d.deliveryOrderId, d.rider);
    expect(await statusOf(s.order.id)).toBe("OUT_FOR_DELIVERY");
    const before = await balanceOf(s.customer.id);

    await cancelOrder(s.order.id, s.customer, "no thanks", { selfService: true });

    expect(await balanceOf(s.customer.id)).toBe(before + GOODS);
    const earning = await earningFor(d.deliveryOrderId);
    expect(earning).toBeTruthy();
    const riderLines = await db
      .select()
      .from(financeLedgerEntries)
      .where(and(eq(financeLedgerEntries.orderId, s.order.id), eq(financeLedgerEntries.entryType, "RIDER_EARNING")));
    expect(riderLines.length).toBeGreaterThan(0);
  });
});

describe("D10 — shop / operator cancellation is unrestricted", () => {
  it("before acceptance the shop can reject: full refund, stock returned", async () => {
    const s = await setup();
    const cancelled = await cancelOrder(s.order.id, s.owner, "Rejected by shop: out of stock");
    expect(cancelled.status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE);
    expect(await stockOf(s.shopProductId)).toBe(50);
  });

  it("after acceptance and preparation the shop can still cancel, with a full refund", async () => {
    const s = await setup();
    await acceptOrder(s.order.id, s.owner);
    await startPicking(s.order.id, s.owner);
    await cancelOrder(s.order.id, s.owner, "Could not fulfil");
    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE);
    expect(await stockOf(s.shopProductId)).toBe(50);
  });

  it("after rider assignment the shop's cancel releases the rider, pays no earning, and refunds in full", async () => {
    const s = await setup();
    const d = await assignRider(s);

    await cancelOrder(s.order.id, s.owner, "Could not fulfil");

    expect((await deliveryRow(d.deliveryOrderId))?.status).toBe("CANCELLED");
    expect(await earningFor(d.deliveryOrderId)).toBeUndefined(); // never picked up: nothing earned
    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE);
    expect(await retainedFeeEntries(s.order.id)).toHaveLength(0);
  });

  it("after pickup the shop's cancel refunds everything incl. the fee (D10 reduces only the customer's own path); the rider is still paid", async () => {
    const s = await setup();
    const d = await pickUp(s);

    await cancelOrder(s.order.id, s.owner, "Shop cancelled");

    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE); // full refund
    expect(await earningFor(d.deliveryOrderId)).toBeTruthy();
    expect(await retainedFeeEntries(s.order.id)).toHaveLength(0); // nothing retained
  });
});

describe("D10 — refund and inventory implications of partial fulfilment", () => {
  it("a removed line is refunded once and NOT restocked; a later cancel refunds only what is still held", async () => {
    const s = await setup({ twoLines: true });
    expect(s.order.totalPaise).toBe(GOODS + 3000 + FEE);
    await acceptOrder(s.order.id, s.owner);
    await startPicking(s.order.id, s.owner);

    const items = await db.query.orderItems.findMany({ where: (t, { eq: e }) => e(t.orderId, s.order.id) });
    const curdLine = items.find((i) => i.productNameSnapshot === "Curd")!;
    await removeItem(s.order.id, curdLine.id, s.owner, "Out of stock");
    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE - (GOODS + 3000 + FEE) + 3000);

    await cancelOrder(s.order.id, s.owner, "Could not fulfil the rest");

    expect(await balanceOf(s.customer.id)).toBe(START_BALANCE); // nothing refunded twice, nothing missed
    expect(await stockOf(s.shopProductId)).toBe(50); // milk restored
    expect(await stockOf(s.curdShopProductId!)).toBe(19); // the removed curd was never taken back
  });
});
