/**
 * Route-level tests for POST /api/orders/[id]/assign and
 * PATCH /api/delivery-orders/[id] (accept/reject/pickup/deliver) — Phase 1a,
 * see docs/gokesari-audit/GOKESARI_IMPLEMENTATION_ROADMAP.md and GAP-006.
 * The assignment/lifecycle SERVICE logic is already well covered
 * (delivery-assignment.test.ts); this file covers the route layer — auth,
 * ownership, status codes — on top of it, ahead of Phase 1b's DEF-03/DEF-04
 * fixes to the service underneath.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

// Several of these tests do a full checkout -> PREPARING -> READY chain and
// then assign/accept/pickup/deliver on top — several round trips against a
// remote-shaped test database, same reasoning as delivery-assignment.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

import { POST as assignRoute } from "@/app/api/orders/[id]/assign/route";
import { PATCH as deliveryOrderRoute } from "@/app/api/delivery-orders/[id]/route";
import { db } from "@/server/db";
import { deliveryOrders, orders, type Order } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { assignNearestPartner } from "@/server/services/delivery-assignment";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { call } from "../helpers/http";
import {
  createCategory,
  createDeliveryPartner,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  resetDatabase,
} from "../helpers/fixtures";

const SHOP_LAT = 18.5;
const SHOP_LNG = 73.85;

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

function signInAsUser(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

/** A READY order at a shop positioned so an online, in-radius partner can be assigned. */
async function setupReadyOrder(): Promise<{ order: Order; owner: { id: string; role: UserRole; email: string; name: string | null }; shop: { id: string } }> {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { latitude: SHOP_LAT, longitude: SHOP_LNG });
  const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000 });

  await addToCart(customer.id, shopProduct.id, 1);
  const { orders: created } = await checkout({ userId: customer.id, requestId: `req-${customer.id}`, addressId: null });
  const actor = { id: owner.id, role: "SHOP_OWNER" as const };
  let order = await updateOrderStatus(created[0].id, "PREPARING", actor);
  order = await updateOrderStatus(order.id, "READY", actor);

  return { order, owner: { ...owner, role: "SHOP_OWNER" }, shop };
}

async function onlinePartner(overrides: { operatingRadiusKm?: number } = {}) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, {
    status: "APPROVED",
    isOnline: true,
    latitude: SHOP_LAT,
    longitude: SHOP_LNG,
    operatingRadiusKm: overrides.operatingRadiusKm ?? 10,
  });
  return { user, partner };
}

describe("POST /api/orders/[id]/assign", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const { order } = await setupReadyOrder();
    const r = await call(assignRoute, `/api/orders/${order.id}/assign`, {
      method: "POST",
      params: { id: order.id },
      body: {},
    });
    expect(r.status).toBe(401);
  });

  it("lets the owning shop assign the nearest online partner", async () => {
    const { order, owner } = await setupReadyOrder();
    await onlinePartner();
    signInAsUser({ ...owner });

    const r = await call(assignRoute, `/api/orders/${order.id}/assign`, {
      method: "POST",
      params: { id: order.id },
      body: {},
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("OFFERED");
  });

  it("returns 409 when no delivery partner is available", async () => {
    const { order, owner } = await setupReadyOrder();
    signInAsUser({ ...owner }); // no onlinePartner() call — none exist

    const r = await call(assignRoute, `/api/orders/${order.id}/assign`, {
      method: "POST",
      params: { id: order.id },
      body: {},
    });
    expect(r.status).toBe(409);
  });

  it("rejects a different shop's owner from triggering assignment (403, ownership)", async () => {
    const { order } = await setupReadyOrder();
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    await createShop(otherOwner.id, { name: "Unrelated Shop" });

    signInAsUser({ ...otherOwner, role: "SHOP_OWNER" });
    const r = await call(assignRoute, `/api/orders/${order.id}/assign`, {
      method: "POST",
      params: { id: order.id },
      body: {},
    });
    expect(r.status).toBe(403);
  });

  it("rejects a shop owner (non-privileged) requesting a manual reassign", async () => {
    const { order, owner } = await setupReadyOrder();
    await onlinePartner();
    signInAsUser({ ...owner });
    await call(assignRoute, `/api/orders/${order.id}/assign`, { method: "POST", params: { id: order.id }, body: {} });

    const r = await call(assignRoute, `/api/orders/${order.id}/assign`, {
      method: "POST",
      params: { id: order.id },
      body: { reassign: true },
    });
    expect(r.status).toBe(403);
  });

  it("lets an operator manually reassign", async () => {
    const { order } = await setupReadyOrder();
    await onlinePartner();
    await onlinePartner();
    await signInOperator();

    await call(assignRoute, `/api/orders/${order.id}/assign`, { method: "POST", params: { id: order.id }, body: {} });
    const r = await call(assignRoute, `/api/orders/${order.id}/assign`, {
      method: "POST",
      params: { id: order.id },
      body: { reassign: true, reason: "test reassignment" },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("OFFERED");
  });
});

async function signInOperator() {
  const operator = await createUser({ role: "OPERATOR" });
  signInAsUser({ ...operator });
  return operator;
}

describe("PATCH /api/delivery-orders/[id]", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const r = await call(deliveryOrderRoute, "/api/delivery-orders/00000000-0000-0000-0000-000000000000", {
      method: "PATCH",
      params: { id: "00000000-0000-0000-0000-000000000000" },
      body: { action: "accept" },
    });
    expect(r.status).toBe(401);
  });

  it("lets the offered partner accept, then pick up, then deliver — and the order tracks it through", async () => {
    const { order, owner } = await setupReadyOrder();
    const { user: partnerUser } = await onlinePartner();
    const assigned = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });

    signInAsUser({ ...partnerUser, role: "DELIVERY_PARTNER" });

    const accept = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "accept" },
    });
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe("ACCEPTED");
    // The rider never receives the handover codes (Slice 4).
    expect(accept.body.pickupCode).toBeUndefined();
    expect(accept.body.needsPickupCode).toBe(true);
    const afterAccept = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
    expect(afterAccept?.status).toBe("ASSIGNED");
    const code = (await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.id, assigned.id) }))!.pickupCode!;

    const pickup = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "pickup", pickupCode: code },
    });
    expect(pickup.status).toBe(200);
    expect(pickup.body.status).toBe("PICKED_UP");
    const afterPickup = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
    expect(afterPickup?.status).toBe("PICKED_UP");

    const start = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "start" },
    });
    expect(start.status).toBe(200);
    expect(start.body.deliveryOtp).toBeUndefined();
    const afterStart = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
    expect(afterStart?.status).toBe("OUT_FOR_DELIVERY");
    const otp = (await db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.id, assigned.id) }))!.deliveryOtp!;

    const deliver = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "deliver", otp },
    });
    expect(deliver.status).toBe(200);
    expect(deliver.body.status).toBe("DELIVERED");
    const afterDeliver = await db.query.orders.findFirst({ where: eq(orders.id, order.id) });
    expect(afterDeliver?.status).toBe("DELIVERED");
  });

  it("lets the offered partner reject", async () => {
    const { order, owner } = await setupReadyOrder();
    const { user: partnerUser } = await onlinePartner();
    const assigned = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });

    signInAsUser({ ...partnerUser, role: "DELIVERY_PARTNER" });
    const r = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "reject", reason: "too far" },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("REJECTED");
  });

  it("rejects a different partner from acting on someone else's offer (403, ownership)", async () => {
    const { order, owner } = await setupReadyOrder();
    await onlinePartner();
    const assigned = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
    const { user: uninvolvedPartner } = await onlinePartner();

    signInAsUser({ ...uninvolvedPartner, role: "DELIVERY_PARTNER" });
    const r = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "accept" },
    });
    expect(r.status).toBe(403);
  });

  it("returns 409 for accepting an offer that is no longer OFFERED", async () => {
    const { order, owner } = await setupReadyOrder();
    const { user: partnerUser } = await onlinePartner();
    const assigned = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });

    signInAsUser({ ...partnerUser, role: "DELIVERY_PARTNER" });
    const first = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "accept" },
    });
    expect(first.status).toBe(200);

    const second = await call(deliveryOrderRoute, `/api/delivery-orders/${assigned.id}`, {
      method: "PATCH",
      params: { id: assigned.id },
      body: { action: "accept" },
    });
    expect(second.status).toBe(409);
  });
});
