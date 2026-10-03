/**
 * Order cancellation refund (wallet & voucher brief §29, TEST 8, TEST 27).
 *
 * Exercises the REAL `cancelOrder` call site — the one place in the app that
 * actually calls `refundOriginalDebit` against a genuine, FK-backed order —
 * rather than only the wallet-engine unit-level behaviour covered in
 * wallet-promotional.test.ts.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { wallets } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { cancelOrder, checkout } from "@/server/services/orders";
import { applyWalletMutation } from "@/server/services/wallet";
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

beforeEach(resetDatabase);

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!;

describe("cancelOrder refund (TEST 8)", () => {
  it("refunds a wallet-paid order back to the customer-funded balance", async () => {
    const { customer } = await setupOneShop(500_000); // ₹5,000, no promo
    await addToCart(customer.id, customer.shopProductId, 1);

    const { orders } = await checkout({ userId: customer.id, requestId: "req-1", addressId: await deliveryAddressId(customer.id) });
    expect(orders[0].totalPaise).toBe(7000);

    const afterCheckout = await balanceOf(customer.id);
    expect(afterCheckout.balancePaise).toBe(500_000 - 7000);

    const cancelled = await cancelOrder(orders[0].id, { id: customer.id, role: "CUSTOMER" }, "Changed my mind");
    expect(cancelled.status).toBe("REFUNDED");

    const afterRefund = await balanceOf(customer.id);
    expect(afterRefund.balancePaise).toBe(500_000);
  });

  it("restores the promotional portion of a wallet-paid order, not just a flat refund", async () => {
    const { customer } = await setupOneShop(0);
    // Give the customer ₹70 customer-funded + ₹70 promotional so the ₹70
    // order can be paid entirely from promotional credit (PROMOTIONAL_FIRST).
    await applyWalletMutation({
      userId: customer.id, amountPaise: 7000, type: "TOP_UP",
      idempotencyKey: "seed-topup", description: "seed",
    });
    await applyWalletMutation({
      userId: customer.id, amountPaise: 7000, type: "PROMOTIONAL_CREDIT",
      idempotencyKey: "seed-promo", description: "seed bonus",
    });

    await addToCart(customer.id, customer.shopProductId, 1);
    const { orders } = await checkout({ userId: customer.id, requestId: "req-2", addressId: await deliveryAddressId(customer.id) });

    const afterCheckout = await balanceOf(customer.id);
    expect(afterCheckout.balancePaise).toBe(7000); // ₹140 - ₹70 order = ₹70 left
    expect(afterCheckout.promotionalBalancePaise).toBe(0); // promo covered it first

    await cancelOrder(orders[0].id, { id: customer.id, role: "CUSTOMER" }, "test refund");

    const afterRefund = await balanceOf(customer.id);
    expect(afterRefund.balancePaise).toBe(14000); // full ₹140 restored
    expect(afterRefund.promotionalBalancePaise).toBe(7000); // the ₹70 promo restored, not customer-funded
  });
});

async function setupOneShop(balancePaise: number) {
  const { user: customerUser } = await createUserWithWallet({ balancePaise });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  const shopProduct = await createShopProduct(shop.id, product.id, {
    onlinePricePaise: 7000,
    onlineStock: 50,
  });
  return {
    customer: { id: customerUser.id, shopProductId: shopProduct.id },
  };
}
