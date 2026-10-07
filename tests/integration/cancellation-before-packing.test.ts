/**
 * Item A (D10 / D6): an order cancelled before it is packed refunds the full
 * amount, delivery fee included, on every path that may cancel it — the
 * customer, the shop, operations, the acceptance timeout, and "every item was
 * unavailable". Rule `cancellation.customerMayCancelUntil` decides only WHO may
 * cancel (the customer until CONFIRMED by default, or until PREPARING); it
 * never changes the amount. After packing nothing changes (see d10 tests).
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { financeLedgerEntries, notifications, orders, platformSettings, wallets } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { acceptOrder, removeItem, startPicking } from "@/server/services/fulfilment";
import { cancelOrder, checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { runShopAcceptanceSweep } from "@/server/services/shop-acceptance";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

const START = 500_000;
const GOODS = 7000;
const FEE = 1500;

async function clearRules() {
  await db.delete(platformSettings).where(eq(platformSettings.key, "cancellation"));
  await db.delete(platformSettings).where(eq(platformSettings.key, "shopAcceptance"));
  clearRuleCache();
}

beforeEach(async () => {
  await resetDatabase();
  await clearRules();
});
afterEach(clearRules);

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;
const orderRow = async (orderId: string) => (await db.query.orders.findFirst({ where: eq(orders.id, orderId) }))!;

async function setup() {
  const { user: customer } = await createUserWithWallet({ balancePaise: START });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const admin = await createUser({ role: "ADMIN" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { deliveryFeePaise: FEE, latitude: 0, longitude: 0 });
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: GOODS, onlineStock: 50 });
  await addToCart(customer.id, sp.id, 1);
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: await deliveryAddressId(customer.id),
  });
  const order = created[0];
  expect(order.deliveryFeePaise).toBe(FEE);
  expect(order.totalPaise).toBe(GOODS + FEE);
  expect(await balanceOf(customer.id)).toBe(START - GOODS - FEE);
  return {
    customer: { id: customer.id, role: "CUSTOMER" as const },
    owner: { id: owner.id, role: "SHOP_OWNER" as const },
    admin: { id: admin.id, role: "ADMIN" as const },
    order,
  };
}

type S = Awaited<ReturnType<typeof setup>>;
const toStatus = async (s: S, status: "CONFIRMED" | "ACCEPTED" | "PREPARING") => {
  if (status === "CONFIRMED") return;
  await acceptOrder(s.order.id, s.owner);
  if (status === "PREPARING") await startPicking(s.order.id, s.owner);
};
const retainedFee = (orderId: string) =>
  db
    .select()
    .from(financeLedgerEntries)
    .where(and(eq(financeLedgerEntries.orderId, orderId), eq(financeLedgerEntries.entryType, "DELIVERY_FEE")));

describe("A — before packing, every cancel refunds goods + delivery fee", () => {
  for (const status of ["CONFIRMED", "ACCEPTED", "PREPARING"] as const) {
    it(`shop cancels at ${status}: full refund incl. delivery fee, no fee retained`, async () => {
      const s = await setup();
      await toStatus(s, status);
      const result = await cancelOrder(s.order.id, s.owner, "Out of stock");
      expect(result.status).toBe("REFUNDED");
      expect(await balanceOf(s.customer.id)).toBe(START);
      expect(await retainedFee(s.order.id)).toHaveLength(0);
    });

    it(`operations cancels at ${status}: full refund incl. delivery fee`, async () => {
      const s = await setup();
      await toStatus(s, status);
      await cancelOrder(s.order.id, s.admin, "Ops cancel");
      expect(await balanceOf(s.customer.id)).toBe(START);
    });
  }

  it("customer cancels at CONFIRMED (default rule): full refund incl. delivery fee", async () => {
    const s = await setup();
    await cancelOrder(s.order.id, s.customer, "Changed my mind", { selfService: true });
    expect(await balanceOf(s.customer.id)).toBe(START);
    expect(await retainedFee(s.order.id)).toHaveLength(0);
  });

  it("acceptance timeout: full refund incl. delivery fee", async () => {
    await setRule("shopAcceptance", { enabled: true, acceptMinutes: 5 }, { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" });
    const s = await setup();
    expect((await orderRow(s.order.id)).acceptByAt).not.toBeNull();
    const result = await runShopAcceptanceSweep(new Date(Date.now() + 10 * 60_000));
    expect(result.cancelled).toBe(1);
    expect(await balanceOf(s.customer.id)).toBe(START);
  });

  it("every item unavailable while picking: lines refunded, then the delivery fee on cancel — full amount back", async () => {
    const s = await setup();
    await toStatus(s, "PREPARING");
    const [item] = await db.query.orderItems.findMany({ where: (t, { eq: e }) => e(t.orderId, s.order.id) });
    await removeItem(s.order.id, item.id, s.owner, "Sold out");
    expect((await orderRow(s.order.id)).status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START);
  });
});

describe("A — rule cancellation.customerMayCancelUntil", () => {
  for (const status of ["ACCEPTED", "PREPARING"] as const) {
    it(`default (CONFIRMED): the customer is still blocked at ${status}`, async () => {
      const s = await setup();
      await toStatus(s, status);
      await expect(cancelOrder(s.order.id, s.customer, "x", { selfService: true })).rejects.toThrow(/contact the shop/);
      expect((await orderRow(s.order.id)).status).toBe(status);
      expect(await balanceOf(s.customer.id)).toBe(START - GOODS - FEE);
    });

    it(`PREPARING: the customer may cancel at ${status}, full refund incl. delivery fee, shop told`, async () => {
      const s = await setup();
      await setRule("cancellation", { customerMayCancelUntil: "PREPARING" }, s.admin);
      await toStatus(s, status);
      const result = await cancelOrder(s.order.id, s.customer, "Ordered by mistake", { selfService: true });
      expect(result.status).toBe("REFUNDED");
      expect(await balanceOf(s.customer.id)).toBe(START);
      expect(await retainedFee(s.order.id)).toHaveLength(0);
      const shopNotes = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, s.owner.id), eq(notifications.type, "order.cancelled")));
      expect(shopNotes).toHaveLength(1);
    });
  }

  it("PREPARING: a packed (READY) order is still blocked for the customer", async () => {
    const s = await setup();
    await setRule("cancellation", { customerMayCancelUntil: "PREPARING" }, s.admin);
    await toStatus(s, "PREPARING");
    await updateOrderStatus(s.order.id, "READY", s.owner);
    await expect(cancelOrder(s.order.id, s.customer, "x", { selfService: true })).rejects.toThrow(/contact the shop/);
    expect(await balanceOf(s.customer.id)).toBe(START - GOODS - FEE);
  });

  it("the customer cancelling at CONFIRMED does not notify the shop (unchanged)", async () => {
    const s = await setup();
    await setRule("cancellation", { customerMayCancelUntil: "PREPARING" }, s.admin);
    await cancelOrder(s.order.id, s.customer, "x", { selfService: true });
    const shopNotes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, s.owner.id), eq(notifications.type, "order.cancelled")));
    expect(shopNotes).toHaveLength(0);
  });
});
