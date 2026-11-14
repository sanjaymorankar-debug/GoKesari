/**
 * The every-minute sweeps leave rows alone that have nothing left to do
 * (Neon activity check, 14 Nov 2026). On test.gokesari.com the dispatch sweep
 * reloaded 79 READY orders whose rider search had stopped, about 7 queries
 * each, every minute; the return-pickup sweep retried the same pickups every
 * minute because a try that found no rider changed nothing on the row.
 *
 * - runDispatchSweep retries only READY orders with no search yet or a search
 *   still running; "Find rider now" brings a stopped one back.
 * - offerPickup counts a try that found no rider: the sweep then waits the
 *   retry interval and stops after maxAttempts, telling the shop.
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { deliveryOrders, notifications, orderItems, orders, returnPickups, riderSearches } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { dispatchReadyOrder, runDispatchSweep } from "@/server/services/delivery-assignment";
import { NOTIFICATION_TYPES } from "@/server/services/notifications";
import { checkout } from "@/server/services/orders";
import { retryPickup, runReturnPickupSweep } from "@/server/services/return-pickups";
import { approveReturn, requestReturn } from "@/server/services/returns";
import { clearRuleCache } from "@/server/services/settings";
import {
  createCategory,
  createOrder,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

const SHOP = { latitude: 18.5, longitude: 73.85 };
/** Default rule dispatch: retryIntervalSeconds 60, maxAttempts 10. */
const MAX_ATTEMPTS = 10;
const longAgo = () => new Date(Date.now() - 10 * 60_000);

describe("dispatch sweep", () => {
  it("skips a READY order whose rider search has stopped, and retries it again after Find rider now", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, SHOP);
    const customer = await createUser();
    const stopped = await createOrder(customer.id, shop.id, { status: "READY" });
    const fresh = await createOrder(customer.id, shop.id, { status: "READY" });
    const stoppedAt = longAgo();
    await db.insert(riderSearches).values({
      orderId: stopped.id,
      status: "STOPPED",
      stopReason: "RETRY_LIMIT",
      attempts: MAX_ATTEMPTS,
      maxAttempts: MAX_ATTEMPTS,
      stoppedAt,
      updatedAt: stoppedAt,
    });

    // No rider anywhere: the new order starts its search, the stopped one is not looked at.
    const first = await runDispatchSweep();
    expect(first).toMatchObject({ attempted: 1, offered: 0 });
    const [untouched] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, stopped.id));
    expect(untouched).toMatchObject({ status: "STOPPED", attempts: MAX_ATTEMPTS });
    expect(untouched.updatedAt.getTime()).toBe(stoppedAt.getTime());
    const [started] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, fresh.id));
    expect(started).toMatchObject({ status: "SEARCHING", attempts: 1 });

    // The shop presses "Find rider now": the search runs again and the sweep takes it back.
    await dispatchReadyOrder(stopped.id, { id: owner.id, role: "SHOP_OWNER" }, "SHOP_MANUAL");
    const [restarted] = await db.select().from(riderSearches).where(eq(riderSearches.orderId, stopped.id));
    expect(restarted).toMatchObject({ status: "SEARCHING", attempts: 1 });
    const second = await runDispatchSweep();
    expect(second.attempted).toBe(2);
    expect(await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, stopped.id))).toHaveLength(0);
  });
});

describe("return-pickup sweep", () => {
  /** An approved return waiting for a rider pickup, with no rider anywhere. */
  async function approvedReturnWithPickup() {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const category = await createCategory({ department: "DAIRY", name: "Milk" });
    const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
    const shop = await createShop(owner.id, SHOP);
    const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineStock: 50 });
    await addToCart(customer.id, shopProduct.id, 1);
    const { orders: created } = await checkout({
      userId: customer.id,
      requestId: `req-${customer.id}`,
      addressId: await deliveryAddressId(customer.id),
    });
    const order = created[0];
    await db
      .update(orders)
      .set({ status: "DELIVERED", deliveryAddressSnapshot: { line1: "Flat 9", city: "Pune", pincode: "411001", latitude: "18.51", longitude: "73.85" } })
      .where(eq(orders.id, order.id));
    const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
    const ret = await requestReturn(
      { orderId: order.id, reason: "MISSING_ITEM", items: [{ orderItemId: line.id, quantityMilli: 1000, condition: "UNOPENED" }] },
      { id: customer.id, role: "CUSTOMER" },
    );
    await approveReturn(ret.id, { id: owner.id, role: "SHOP_OWNER" });
    return { owner, ret };
  }

  const pickupOf = async (returnId: string) => (await db.select().from(returnPickups).where(eq(returnPickups.returnId, returnId)))[0];
  const age = (id: string, attempts?: number) =>
    db.update(returnPickups).set({ updatedAt: longAgo(), ...(attempts === undefined ? {} : { attempts }) }).where(eq(returnPickups.id, id));

  it("counts a try that finds no rider, waits the retry interval, and stops after maxAttempts with the shop told", async () => {
    const { owner, ret } = await approvedReturnWithPickup();
    // Approval offered it once already: nobody, so that try counts.
    const pickup = await pickupOf(ret.id);
    expect(pickup).toMatchObject({ status: "PENDING", attempts: 1 });

    await age(pickup.id);
    expect((await runReturnPickupSweep()).offered).toBe(0);
    expect((await pickupOf(ret.id)).attempts).toBe(2);
    // The next minute's sweep finds it inside the retry interval and leaves it.
    await runReturnPickupSweep();
    expect((await pickupOf(ret.id)).attempts).toBe(2);

    // The last try: the search gives up and the shop is told once.
    await age(pickup.id, MAX_ATTEMPTS - 1);
    await runReturnPickupSweep();
    expect((await pickupOf(ret.id)).attempts).toBe(MAX_ATTEMPTS);
    const told = () =>
      db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, owner.id), eq(notifications.type, NOTIFICATION_TYPES.RETURN_PICKUP_UNASSIGNED)));
    expect(await told()).toHaveLength(1);
    await age(pickup.id);
    await runReturnPickupSweep();
    expect((await pickupOf(ret.id)).attempts).toBe(MAX_ATTEMPTS);
    expect(await told()).toHaveLength(1);

    // The shop's retry starts the count again.
    await retryPickup(ret.id);
    expect(await pickupOf(ret.id)).toMatchObject({ status: "PENDING", attempts: 1 });
  });
});
