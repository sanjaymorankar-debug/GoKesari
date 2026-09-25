/**
 * Route-level tests for PATCH /api/orders/[id]/status (Phase 1a/1b — see
 * docs/gokesari-audit/GOKESARI_IMPLEMENTATION_ROADMAP.md).
 *
 * Everything below runs the REAL route handler (auth → validation → service
 * → response), not just the service function — that layer had never had a
 * test before this file (GAP-006 in the gap analysis).
 *
 * The tests below marked "DEF-06 fixed" / "DEF-08 fixed" originally shipped
 * as CHARACTERIZATION tests asserting the pre-fix bugs — see git history for
 * the red version. They now assert the fixed behaviour, updated in the same
 * change as the fix itself (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md).
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

// Mocks only the session SOURCE. Everything downstream — requireUser,
// requirePermission, requireShopAccess, the real permission matrix, the real
// ownership DB queries — runs completely unmodified, so these tests exercise
// the actual authorization code, bugs included.
vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { PATCH as statusRoute } from "@/app/api/orders/[id]/status/route";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartnerEarnings, orders, wallets } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  markPickedUp,
  startDelivery,
} from "@/server/services/delivery-assignment";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { call } from "../helpers/http";
import {
  createCategory,
  createDeliveryPartner,
  createOrder,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

async function signIn(role: UserRole) {
  const user = await createUser({ role });
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" },
  };
  return user;
}

function signInAsUser(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;

/** Milk shop at ₹70 with a ₹10 delivery fee — non-zero so DEF-08's "delivery fee kept vs refunded" is a real, observable number. */
async function paidOrderSetup(customerBalancePaise = 500_000) {
  const { user: customer } = await createUserWithWallet({ balancePaise: customerBalancePaise });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { deliveryFeePaise: 1000, latitude: 0, longitude: 0 });
  const shopProduct = await createShopProduct(shop.id, product.id, {
    onlinePricePaise: 7000,
    onlineStock: 50,
  });

  await addToCart(customer.id, shopProduct.id, 1);
  const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: null });
  const order = created[0];
  expect(order.totalPaise).toBe(8000); // 7000 subtotal + 1000 delivery fee, sanity check on the fixture itself

  return { customer, owner, shop, order };
}

describe("PATCH /api/orders/[id]/status", () => {
  describe("authentication", () => {
    it("rejects an unauthenticated caller with 401", async () => {
      const { order } = await paidOrderSetup();
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "CANCELLED" },
      });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("UNAUTHENTICATED");
    });
  });

  describe("customer self-cancel", () => {
    it("lets the customer cancel their own CONFIRMED order with a full refund (correct today, unaffected by DEF-08's fix)", async () => {
      const { customer, order } = await paidOrderSetup();
      expect(await balanceOf(customer.id)).toBe(500_000 - 8000);

      signInAsUser({ ...customer, role: "CUSTOMER" });
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "CANCELLED" },
      });

      expect(r.status).toBe(200);
      expect(r.body.status).toBe("REFUNDED");
      expect(await balanceOf(customer.id)).toBe(500_000); // full refund incl. delivery fee — correct at CONFIRMED
    });

    it("DEF-08 fixed: a customer cannot cancel while the shop is PREPARING — must contact the shop instead", async () => {
      const { customer, owner, order } = await paidOrderSetup();
      await updateOrderStatus(order.id, "PREPARING", { id: owner.id, role: "SHOP_OWNER" });
      const balanceBefore = await balanceOf(customer.id);

      signInAsUser({ ...customer, role: "CUSTOMER" });
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "CANCELLED" },
      });

      expect(r.status).toBe(409);
      const reloaded = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
      expect(reloaded?.status).toBe("PREPARING"); // unchanged
      expect(await balanceOf(customer.id)).toBe(balanceBefore); // nothing refunded
    });

    it("DEF-08 fixed: cancelling an OUT_FOR_DELIVERY order refunds goods only, keeps the delivery fee, and still pays the rider", async () => {
      const { customer, owner, order } = await paidOrderSetup();
      await updateOrderStatus(order.id, "PREPARING", { id: owner.id, role: "SHOP_OWNER" });
      await updateOrderStatus(order.id, "READY", { id: owner.id, role: "SHOP_OWNER" });

      const partnerUser = await createUser({ role: "DELIVERY_PARTNER" });
      await createDeliveryPartner(partnerUser.id, {
        status: "APPROVED",
        isOnline: true,
        latitude: 0,
        longitude: 0,
        operatingRadiusKm: 50,
      });
      const assigned = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
      await acceptDeliveryOffer(assigned.id, partnerUser.id);
      const rider = { id: partnerUser.id, role: "DELIVERY_PARTNER" as const };
      const { pickupCode } = (await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.id, assigned.id) }))!;
      await markPickedUp(assigned.id, rider, pickupCode!);
      await startDelivery(assigned.id, rider); // advances the order to OUT_FOR_DELIVERY

      const balanceBefore = await balanceOf(customer.id); // 500_000 - 8000

      signInAsUser({ ...customer, role: "CUSTOMER" });
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "CANCELLED" },
      });

      expect(r.status).toBe(200);
      expect(r.body.status).toBe("REFUNDED");
      // Goods only (7000) refunded, not the full 8000 — the 1000 delivery fee is kept.
      expect(await balanceOf(customer.id)).toBe(balanceBefore + 7000);

      const earning = await db.query.deliveryPartnerEarnings.findFirst({
        where: eq(deliveryPartnerEarnings.deliveryOrderId, assigned.id),
      });
      expect(earning).toBeTruthy(); // the rider is still paid for the trip
    });

    it("rejects a customer cancelling someone else's order with 403", async () => {
      const { order } = await paidOrderSetup();
      const otherCustomer = await createUser({ role: "CUSTOMER" });

      signInAsUser({ ...otherCustomer, role: "CUSTOMER" });
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "CANCELLED" },
      });
      expect(r.status).toBe(403);
    });
  });

  describe("shop / operator status advancement", () => {
    it("lets the owning shop advance CONFIRMED -> PREPARING", async () => {
      const { owner, order } = await paidOrderSetup();
      signInAsUser({ ...owner, role: "SHOP_OWNER" });

      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "PREPARING" },
      });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("PREPARING");
    });

    it("rejects a different shop's owner from touching this order (403, ownership)", async () => {
      const { order } = await paidOrderSetup();
      const otherOwner = await createUser({ role: "SHOP_OWNER" });
      await createShop(otherOwner.id, { name: "Unrelated Shop" });

      signInAsUser({ ...otherOwner, role: "SHOP_OWNER" });
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "PREPARING" },
      });
      expect(r.status).toBe(403);
    });

    it("lets an operator advance any shop's order", async () => {
      const { order } = await paidOrderSetup();
      await signIn("OPERATOR");

      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "PREPARING" },
      });
      expect(r.status).toBe(200);
    });

    it("DEF-06 fixed: CONFIRMED is no longer an accepted target on this endpoint, so an unpaid order cannot be marked paid this way", async () => {
      const owner = await createUser({ role: "SHOP_OWNER" });
      const shop = await createShop(owner.id);
      const customer = await createUser({ role: "CUSTOMER" });
      const order = await createOrder(customer.id, shop.id, { status: "WALLET_INSUFFICIENT", paidAt: null });

      signInAsUser({ ...owner, role: "SHOP_OWNER" });
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "CONFIRMED" },
      });

      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("VALIDATION_FAILED");
      const reloaded = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
      expect(reloaded?.status).toBe("WALLET_INSUFFICIENT"); // unchanged
      expect(reloaded?.paidAt).toBeNull();
    });
  });

  describe("validation", () => {
    it("rejects an invalid status value with 422", async () => {
      const { owner, order } = await paidOrderSetup();
      signInAsUser({ ...owner, role: "SHOP_OWNER" });

      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "NOT_A_REAL_STATUS" },
      });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("VALIDATION_FAILED");
    });

    it("404s for a nonexistent order id", async () => {
      await signIn("OPERATOR");
      const r = await call(statusRoute, "/api/orders/00000000-0000-0000-0000-000000000000/status", {
        method: "PATCH",
        params: { id: "00000000-0000-0000-0000-000000000000" },
        body: { status: "PREPARING" },
      });
      expect(r.status).toBe(404);
    });

    it("rejects an illegal transition with 409", async () => {
      const owner = await createUser({ role: "SHOP_OWNER" });
      const shop = await createShop(owner.id);
      const customer = await createUser({ role: "CUSTOMER" });
      const order = await createOrder(customer.id, shop.id, { status: "DELIVERED", paidAt: new Date() });

      signInAsUser({ ...owner, role: "SHOP_OWNER" });
      const r = await call(statusRoute, `/api/orders/${order.id}/status`, {
        method: "PATCH",
        params: { id: order.id },
        body: { status: "PREPARING" },
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("INVALID_STATE_TRANSITION");
    });
  });
});
