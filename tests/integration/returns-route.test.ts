/**
 * GET / PATCH /api/returns/[id]: each viewer gets the return case as
 * ReturnCase shows it — never the whole rows. The return row carries the
 * customer's pickup address (their delivery address snapshot, coordinates
 * included), their user id and staff ids; the pickup row carries the rider,
 * declined riders and the handover code only the customer may see.
 * The same getReturnDetail() result is what /returns/[id], /shop/returns and
 * /admin/returns pass to the client component.
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

import { GET as returnGet, PATCH as returnPatch } from "@/app/api/returns/[id]/route";
import { db } from "@/server/db";
import { orderItems, orders, returnPickups } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { checkout } from "@/server/services/orders";
import { requestReturn } from "@/server/services/returns";
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

function signInAs(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

const ADDRESS = {
  line1: "Flat 9, Secret Towers",
  area: "Kothrud",
  city: "Pune",
  pincode: "411001",
  latitude: "18.5074321",
  longitude: "73.8077654",
  landmark: "Behind the blue temple",
  deliveryInstructions: "Ring twice",
};

const RET_KEYS = [
  "comment",
  "decisionNote",
  "id",
  "inspectionNote",
  "reason",
  "refundAmountPaise",
  "refundedPaise",
  "returnNumber",
  "status",
];
const ITEM_KEYS = ["comment", "condition", "id", "imageIds", "productName", "quantityMilli", "refundPaise", "unit"];
const HISTORY_KEYS = ["createdAt", "id", "note", "toStatus"];

/** A delivered order with the customer's full address on it, and a return under review for its one line. */
async function returnUnderReview() {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER", name: "Shop Owner" });
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
  await db
    .update(orders)
    .set({ status: "DELIVERED", deliveryAddressSnapshot: ADDRESS })
    .where(eq(orders.id, order.id));
  const [line] = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const ret = await requestReturn(
    {
      orderId: order.id,
      reason: "MISSING_ITEM",
      comment: "Only one packet came",
      items: [{ orderItemId: line.id, quantityMilli: 1000, condition: "UNOPENED" }],
    },
    { id: customer.id, role: "CUSTOMER" },
  );
  const operator = await createUser({ role: "OPERATOR" });
  return { customer, owner, operator, ret };
}

/** Nothing from the whole rows anywhere in the JSON: address, coordinates, ids. */
function expectNoRowLeaks(body: unknown, ids: string[]) {
  const json = JSON.stringify(body);
  for (const secret of [ADDRESS.line1, ADDRESS.latitude, ADDRESS.longitude, ADDRESS.landmark, ADDRESS.deliveryInstructions, ...ids]) {
    expect(json).not.toContain(secret);
  }
  for (const key of ["pickupAddress", "userId", "decidedBy", "inspectedBy", "changedBy", "deliveryPartnerId", "rejectedPartnerIds", "chargeTo"]) {
    expect(json).not.toContain(`"${key}"`);
  }
}

async function approveAsShop(owner: { id: string; email: string; name: string | null; role: UserRole }, returnId: string) {
  signInAs(owner);
  return call(returnPatch, `/api/returns/${returnId}`, {
    method: "PATCH",
    params: { id: returnId },
    body: { action: "approve", note: "Sorry about that" },
  });
}

describe("GET /api/returns/[id]", () => {
  it("gives the shop the case without the customer's address, ids or the handover code", async () => {
    const { customer, owner, ret } = await returnUnderReview();
    const approved = await approveAsShop(owner, ret.id);
    expect(approved.status).toBe(200);

    const r = await call(returnGet, `/api/returns/${ret.id}`, { params: { id: ret.id } });
    expect(r.status).toBe(200);
    expect(r.body.viewer).toBe("SHOP");
    expect(Object.keys(r.body.ret).sort()).toEqual(RET_KEYS);
    expect(r.body.ret).toMatchObject({ id: ret.id, returnNumber: ret.returnNumber, status: "APPROVED", comment: "Only one packet came" });
    expect(r.body.ret.decisionNote).toBe("Sorry about that");
    expect(r.body.customerName).toBe(customer.name);
    expect(r.body.items).toHaveLength(1);
    expect(Object.keys(r.body.items[0]).sort()).toEqual(ITEM_KEYS);
    expect(r.body.items[0]).toMatchObject({ productName: "Cow Milk", quantityMilli: 1000, condition: "UNOPENED" });
    expect(r.body.history.length).toBeGreaterThanOrEqual(3);
    for (const h of r.body.history) expect(Object.keys(h).sort()).toEqual(HISTORY_KEYS);
    expect(Object.keys(r.body.pickup).sort()).toEqual(["scheduledFor", "status"]);
    expect(r.body.pickup.status).toBe("PENDING");
    expect(r.body.actions).toContain("retry_pickup");
    expectNoRowLeaks(r.body, [customer.id, owner.id]);
  });

  it("gives the customer their handover code, and nothing of the staff or rider", async () => {
    const { customer, owner, ret } = await returnUnderReview();
    await approveAsShop(owner, ret.id);
    const [pickup] = await db.select().from(returnPickups).where(eq(returnPickups.returnId, ret.id));

    signInAs(customer);
    const r = await call(returnGet, `/api/returns/${ret.id}`, { params: { id: ret.id } });
    expect(r.status).toBe(200);
    expect(r.body.viewer).toBe("CUSTOMER");
    expect(r.body.customerName).toBeNull();
    expect(r.body.pickup).toMatchObject({ status: "PENDING", handoverCode: pickup.handoverCode });
    expect(Object.keys(r.body.ret).sort()).toEqual(RET_KEYS);
    expectNoRowLeaks(r.body, [owner.id]);
  });

  it("gives staff the case without the handover code", async () => {
    const { customer, owner, operator, ret } = await returnUnderReview();
    await approveAsShop(owner, ret.id);

    signInAs(operator);
    const r = await call(returnGet, `/api/returns/${ret.id}`, { params: { id: ret.id } });
    expect(r.status).toBe(200);
    expect(r.body.viewer).toBe("STAFF");
    expect(r.body.customerName).toBe(customer.name);
    expect(Object.keys(r.body.pickup).sort()).toEqual(["scheduledFor", "status"]);
    expectNoRowLeaks(r.body, [customer.id, owner.id]);
  });
});

describe("PATCH /api/returns/[id]", () => {
  it("answers a shop decision with the shop's view of the case, not the return row", async () => {
    const { customer, owner, ret } = await returnUnderReview();
    const r = await approveAsShop(owner, ret.id);
    expect(r.status).toBe(200);
    expect(r.body.viewer).toBe("SHOP");
    expect(r.body.ret.status).toBe("APPROVED");
    expect(Object.keys(r.body.ret).sort()).toEqual(RET_KEYS);
    expect(r.body.pickup.handoverCode).toBeUndefined();
    expectNoRowLeaks(r.body, [customer.id, owner.id]);
  });

  it("never gives the shop the customer's handover code on retry_pickup", async () => {
    const { customer, owner, ret } = await returnUnderReview();
    await approveAsShop(owner, ret.id);

    const r = await call(returnPatch, `/api/returns/${ret.id}`, {
      method: "PATCH",
      params: { id: ret.id },
      body: { action: "retry_pickup" },
    });
    expect(r.status).toBe(200);
    expect(r.body.ret.status).toBe("APPROVED");
    expect(r.body.pickup.status).toBe("PENDING");
    expect(JSON.stringify(r.body)).not.toContain('"handoverCode"');
    expectNoRowLeaks(r.body, [customer.id, owner.id]);
  });

  it("still refuses retry_pickup to the customer", async () => {
    const { customer, owner, ret } = await returnUnderReview();
    await approveAsShop(owner, ret.id);

    signInAs(customer);
    const r = await call(returnPatch, `/api/returns/${ret.id}`, {
      method: "PATCH",
      params: { id: ret.id },
      body: { action: "retry_pickup" },
    });
    expect(r.status).toBe(403);
  });

  it("answers the customer's schedule with their view, handover code included", async () => {
    const { customer, owner, ret } = await returnUnderReview();
    await approveAsShop(owner, ret.id);
    const [pickup] = await db.select().from(returnPickups).where(eq(returnPickups.returnId, ret.id));

    signInAs(customer);
    const when = new Date(Date.now() + 3_600_000);
    const r = await call(returnPatch, `/api/returns/${ret.id}`, {
      method: "PATCH",
      params: { id: ret.id },
      body: { action: "schedule", scheduledFor: when.toISOString() },
    });
    expect(r.status).toBe(200);
    expect(r.body.viewer).toBe("CUSTOMER");
    expect(new Date(r.body.pickup.scheduledFor).getTime()).toBe(when.getTime());
    expect(r.body.pickup.handoverCode).toBe(pickup.handoverCode);
    expectNoRowLeaks(r.body, [owner.id]);
  });
});
