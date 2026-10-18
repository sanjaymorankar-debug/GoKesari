/**
 * batch-2026-10 WS-C test helpers: a paid order at any status, and rule
 * overrides that are cleared between tests.
 */
import { eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import { orders, platformSettings, supportCannedReplies, wallets, type OrderStatus } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
import { clearRuleCache } from "@/server/services/settings";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
} from "./fixtures";

export const START = 500_000;
export const GOODS = 10_000;
export const DELIVERY_FEE = 1_500;

const RULE_KEYS = ["afterPackingCancellation", "refundChoice", "helpdesk", "grievanceOfficer", "cancellation"];

export async function clearBatchCRules(): Promise<void> {
  await db.delete(platformSettings).where(inArray(platformSettings.key, RULE_KEYS));
  await db.delete(supportCannedReplies);
  clearRuleCache();
}

export async function setRuleRaw(key: string, value: Record<string, unknown>): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
  clearRuleCache();
}

export const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))?.balancePaise ?? null;

/** A wallet-paid order (real checkout: ₹100 goods + ₹15 delivery), moved to `status`. */
export async function paidOrderAt(status: OrderStatus = "CONFIRMED") {
  const { user: customer } = await createUserWithWallet({ balancePaise: START });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const admin = await createUser({ role: "ADMIN" });
  const operator = await createUser({ role: "OPERATOR" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { deliveryFeePaise: DELIVERY_FEE, latitude: 0, longitude: 0 });
  const sp = await createShopProduct(shop.id, product.id, { onlinePricePaise: GOODS, onlineStock: 50 });
  await addToCart(customer.id, sp.id, 1);
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: await deliveryAddressId(customer.id),
  });
  const order = created[0];
  if (status !== "CONFIRMED") await db.update(orders).set({ status }).where(eq(orders.id, order.id));
  return {
    customer: { id: customer.id, role: "CUSTOMER" as const, email: customer.email, name: customer.name },
    owner: { id: owner.id, role: "SHOP_OWNER" as const, email: owner.email, name: owner.name },
    admin: { id: admin.id, role: "ADMIN" as const, email: admin.email, name: admin.name },
    operator: { id: operator.id, role: "OPERATOR" as const, email: operator.email, name: operator.name },
    shop,
    order,
  };
}
