/**
 * POST /api/orders/[id]/fulfilment answers the shop with the order's new
 * state only. The order row carries the customer's delivery address
 * (coordinates included), their user and address ids, the checkout key
 * (which embeds the user id) and the coupon code — none of the shop's
 * business. /shop/orders refreshes from the server and ignores the body.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as fulfilmentRoute } from "@/app/api/orders/[id]/fulfilment/route";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
import { call } from "../helpers/http";
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

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

async function confirmedOrder() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { latitude: 0, longitude: 0 });
  const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000, onlineStock: 50 });
  await addToCart(customer.id, shopProduct.id, 1);
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: await deliveryAddressId(customer.id),
  });
  const order = created[0];
  // Precise coordinates on the snapshot, so a leak of the address would show.
  await db
    .update(orders)
    .set({ deliveryAddressSnapshot: { line1: "2 Test Lane", city: "Pune", pincode: "411001", latitude: "18.5074321", longitude: "73.8077654" } })
    .where(eq(orders.id, order.id));
  state.session = {
    user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: "SHOP_OWNER", status: "ACTIVE" },
  };
  return { customer, order };
}

const act = (orderId: string, body: Record<string, unknown>) =>
  call(fulfilmentRoute, `/api/orders/${orderId}/fulfilment`, { method: "POST", params: { id: orderId }, body });

function expectOnlyState(body: unknown, customerId: string) {
  const json = JSON.stringify(body);
  for (const leak of [customerId, "18.5074321", "73.8077654", "2 Test Lane", '"deliveryAddressSnapshot"', '"checkoutKey"', '"userId"']) {
    expect(json).not.toContain(leak);
  }
}

describe("POST /api/orders/[id]/fulfilment", () => {
  it("answers accept, start and ready with { id, orderNumber, status } only", async () => {
    const { customer, order } = await confirmedOrder();

    for (const [action, status] of [
      ["accept", "ACCEPTED"],
      ["start", "PREPARING"],
      ["ready", "READY"],
    ] as const) {
      const r = await act(order.id, { action });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ id: order.id, orderNumber: order.orderNumber, status });
      expectOnlyState(r.body, customer.id);
    }
  });

  it("answers a rejection the same way", async () => {
    const { customer, order } = await confirmedOrder();

    const r = await act(order.id, { action: "reject", reason: "Closed today" });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["id", "orderNumber", "status"]);
    const reloaded = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
    expect(r.body.status).toBe(reloaded?.status);
    expectOnlyState(r.body, customer.id);
  });
});
