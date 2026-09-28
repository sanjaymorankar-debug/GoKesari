/**
 * DEF-02 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): order and stock
 * notification TYPES were defined in notifications.ts but never actually
 * emitted anywhere. This file proves the wiring added to checkout(),
 * updateOrderStatus() and cancelOrder() actually fires — not just that the
 * order/wallet/stock side effects those functions already had are
 * unaffected (those are covered by checkout.test.ts, order-cancel-refund.test.ts,
 * and delivery-assignment.test.ts already).
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { notifications } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { cancelOrder, checkout, updateOrderStatus } from "@/server/services/orders";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(resetDatabase);

const notificationsFor = (userId: string, type: string) =>
  db.query.notifications.findMany({
    where: and(eq(notifications.userId, userId), eq(notifications.type, type)),
  });

async function paidOrderSetup() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id);
  const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineStock: 50 });

  await addToCart(customer.id, shopProduct.id, 1);
  const { orders } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: null });
  return { customer, owner, order: orders[0] };
}

describe("checkout() notifications (DEF-02)", () => {
  it("notifies the customer their order is confirmed", async () => {
    const { customer, order } = await paidOrderSetup();
    const rows = await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_CONFIRMED);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain(order.orderNumber);
  });

  it("notifies the shop owner of the new order", async () => {
    const { owner, order } = await paidOrderSetup();
    const rows = await notificationsFor(owner.id, NOTIFICATION_TYPES.SHOP_NEW_ORDER);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain(order.orderNumber);
  });
});

describe("updateOrderStatus() notifications (DEF-02)", () => {
  it("notifies the customer at READY, OUT_FOR_DELIVERY and DELIVERED, but not at PREPARING", async () => {
    const { customer, owner, order } = await paidOrderSetup();
    const actor = { id: owner.id, role: "SHOP_OWNER" as const };

    await updateOrderStatus(order.id, "PREPARING", actor);
    expect(await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_READY)).toHaveLength(0);

    await updateOrderStatus(order.id, "READY", actor);
    expect(await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_READY)).toHaveLength(1);

    await updateOrderStatus(order.id, "OUT_FOR_DELIVERY", actor);
    expect(await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_OUT_FOR_DELIVERY)).toHaveLength(1);

    await updateOrderStatus(order.id, "DELIVERED", actor);
    expect(await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_DELIVERED)).toHaveLength(1);
  });
});

describe("cancelOrder() notifications (DEF-02)", () => {
  it("notifies the customer when the SHOP cancels their order", async () => {
    const { customer, owner, order } = await paidOrderSetup();
    await cancelOrder(order.id, { id: owner.id, role: "SHOP_OWNER" }, "Out of stock");
    const rows = await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_CANCELLED);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain("Out of stock");
  });

  it("does NOT notify the customer when they cancel their own order — they already know", async () => {
    const { customer, order } = await paidOrderSetup();
    await cancelOrder(order.id, { id: customer.id, role: "CUSTOMER" }, "Changed my mind", { selfService: true });
    expect(await notificationsFor(customer.id, NOTIFICATION_TYPES.ORDER_CANCELLED)).toHaveLength(0);
  });
});
