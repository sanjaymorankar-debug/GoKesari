/**
 * Delivery management API routes (docs/hdms-2026-11): who may call what, and that secrets and other
 * shops' data never leak. The route handlers run exactly as the HTTP layer runs them.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { PATCH as providerPatch } from "@/app/api/admin/delivery/providers/[code]/route";
import { POST as zoneSuspend } from "@/app/api/admin/delivery/zones/[id]/route";
import { POST as zoneCreate } from "@/app/api/admin/delivery/zones/route";
import { POST as allocateRoute } from "@/app/api/admin/delivery/orders/[orderId]/allocate/route";
import { PATCH as staffProfile } from "@/app/api/shops/[id]/delivery-staff/[staffId]/profile/route";
import { POST as shopAllocate } from "@/app/api/shops/[id]/orders/[orderId]/delivery-partner/route";
import { GET as trackingGet } from "@/app/api/tracking/[orderId]/route";
import { POST as webhookPost } from "@/app/api/webhooks/delivery/[provider]/route";
import { db } from "@/server/db";
import { deliveryProviders, deliveryZones } from "@/server/db/hdms-schema";
import { featureFlags, orders, shopDeliveryStaff } from "@/server/db/schema";
import { allocateOrder } from "@/server/delivery/allocation";
import { resetMock } from "@/server/delivery/providers/mock";
import { encryptCredentials } from "@/server/integrations/credentials";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { NextRequest } from "next/server";
import { call } from "../helpers/http";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

function signIn(user: { id: string; email: string; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: null, image: null, role: user.role, status: "ACTIVE" } };
}

async function seed() {
  await db.execute(sql`DELETE FROM delivery_providers`);
  await db.execute(sql`DELETE FROM delivery_zones`);
  await db.insert(deliveryProviders).values([
    { code: "MOCK", name: "Sandbox simulator", enabled: true, timeoutMs: 800, capabilities: { integrated: true, refrigerated: true, sandboxOnly: true }, webhookSecretEncrypted: encryptCredentials({ secret: "s3cret" }) },
    { code: "SHADOWFAX", name: "Shadowfax", enabled: false, capabilities: { integrated: false } },
  ]);
  const [zone] = await db.insert(deliveryZones).values({ code: "PUN-BANER", name: "Baner", city: "Pune", centerLat: "18.559", centerLng: "73.7868", radiusM: 3000 }).returning();
  await db.insert(featureFlags).values({ key: "hdms_enabled", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  clearFeatureFlagCache();
  resetMock();
  return zone;
}

async function shopWithReadyOrder() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { latitude: 18.559, longitude: 73.7868 });
  const customer = await createUser();
  const order = await createOrder(customer.id, shop.id, { status: "READY" });
  await db
    .update(orders)
    .set({ deliveryAddressSnapshot: { line1: "x", city: "Pune", pincode: "411045", latitude: "18.566", longitude: "73.792" } })
    .where(eq(orders.id, order.id));
  return { owner, shop, customer, order };
}

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

describe("HDMS routes: access control", () => {
  it("only a Super Admin configures partners; the response never carries secrets", async () => {
    await seed();
    const customer = await createUser();
    signIn(customer);
    expect((await call(providerPatch, "/x", { method: "PATCH", params: { code: "mock" }, body: { priority: 5 } })).status).toBe(403);
    const ops = await createUser({ role: "OPERATOR" });
    signIn(ops);
    expect((await call(providerPatch, "/x", { method: "PATCH", params: { code: "mock" }, body: { priority: 5 } })).status).toBe(403);
    const admin = await createUser({ role: "ADMIN" });
    signIn(admin);
    const r = await call(providerPatch, "/x", { method: "PATCH", params: { code: "mock" }, body: { credentials: { apiKey: "topsecret-key" }, webhookSecret: "whsec-abc" } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("topsecret-key");
    expect(JSON.stringify(r.body)).not.toContain("whsec-abc");
    expect(r.body.hasCredentials).toBe(true);
    const bad = await call(providerPatch, "/x", { method: "PATCH", params: { code: "mock" }, body: { baseUrl: "http://insecure.example" } });
    expect(bad.status).toBe(422);
  });

  it("operations may suspend a zone but not create one; customers may do neither", async () => {
    const zone = await seed();
    const customer = await createUser();
    signIn(customer);
    expect((await call(zoneSuspend, "/x", { method: "POST", params: { id: zone.id }, body: { action: "suspend", reason: "Heavy rain" } })).status).toBe(403);
    const ops = await createUser({ role: "OPERATOR" });
    signIn(ops);
    expect((await call(zoneSuspend, "/x", { method: "POST", params: { id: zone.id }, body: { action: "suspend", reason: "Heavy rain", hours: 3 } })).status).toBe(200);
    expect((await call(zoneCreate, "/x", { method: "POST", body: { code: "PUN-X", name: "X", city: "Pune", centerLat: 18.5, centerLng: 73.8, radiusM: 2000, maxDeliveryKm: 5 } })).status).toBe(403);
  });

  it("a shop cannot touch another shop's rider or order", async () => {
    await seed();
    const a = await shopWithReadyOrder();
    const b = await shopWithReadyOrder();
    const [staff] = await db.insert(shopDeliveryStaff).values({ shopId: a.shop.id, name: "R", phoneE164: "+919800000009" }).returning();
    signIn(b.owner);
    // b's owner, a's shop → forbidden
    expect((await call(staffProfile, "/x", { method: "PATCH", params: { id: a.shop.id, staffId: staff.id }, body: { isAvailable: false } })).status).toBe(403);
    // b's owner, own shop id, a's rider → not found
    expect((await call(staffProfile, "/x", { method: "PATCH", params: { id: b.shop.id, staffId: staff.id }, body: { isAvailable: false } })).status).toBe(404);
    // b's owner, own shop, a's order → not found
    expect((await call(shopAllocate, "/x", { method: "POST", params: { id: b.shop.id, orderId: a.order.id } })).status).toBe(404);
    expect((await call(shopAllocate, "/x", { method: "POST", params: { id: a.shop.id, orderId: a.order.id } })).status).toBe(403);
    // the right shop works
    signIn(a.owner);
    const ok = await call(shopAllocate, "/x", { method: "POST", params: { id: a.shop.id, orderId: a.order.id } });
    expect(ok.status).toBe(200);
  });

  it("customers cannot run the allocation engine", async () => {
    await seed();
    const { order, customer } = await shopWithReadyOrder();
    signIn(customer);
    expect((await call(allocateRoute, "/x", { method: "POST", params: { orderId: order.id }, body: {} })).status).toBe(403);
  });
});

describe("HDMS routes: tracking and webhooks", () => {
  it("the customer sees partner tracking with a masked rider number; a stranger is refused", async () => {
    await seed();
    const { order, customer } = await shopWithReadyOrder();
    const booked = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(booked.outcome).toBe("BOOKED");
    const { signMockWebhook } = await import("@/server/delivery/providers/mock");
    const raw = JSON.stringify({ events: [{ id: "t1", ref: booked.booking!.externalRef, status: "PICKED_UP", riderName: "Sandbox Rider", riderPhone: "+919811112222", lat: 18.562, lng: 73.79 }] });
    const res = await webhookPost(
      new NextRequest("http://localhost/api/webhooks/delivery/mock", { method: "POST", body: raw, headers: { "x-mock-signature": signMockWebhook(raw, "s3cret") } }),
      { params: Promise.resolve({ provider: "mock" }) },
    );
    expect(res.status).toBe(200);
    signIn(customer);
    const t = await call(trackingGet, "/x", { params: { orderId: order.id } });
    expect(t.status).toBe(200);
    expect(t.body.partner.providerName).toBe("Sandbox simulator");
    expect(t.body.partner.statusLabel).toBe("Order picked up");
    expect(t.body.partner.riderPhoneMasked).toBe("+91 98XXXXXX22");
    expect(JSON.stringify(t.body)).not.toContain("9811112222");
    const stranger = await createUser();
    signIn(stranger);
    expect((await call(trackingGet, "/x", { params: { orderId: order.id } })).status).toBe(403);
  });

  it("webhooks for a partner that is not integrated are refused", async () => {
    await seed();
    const raw = JSON.stringify({ events: [{ id: "z", ref: "SFX1", status: "DELIVERED" }] });
    const res = await webhookPost(new NextRequest("http://localhost/api/webhooks/delivery/shadowfax", { method: "POST", body: raw }), { params: Promise.resolve({ provider: "shadowfax" }) });
    expect(res.status).toBe(401);
    const unknown = await webhookPost(new NextRequest("http://localhost/api/webhooks/delivery/nobody", { method: "POST", body: raw }), { params: Promise.resolve({ provider: "nobody" }) });
    expect(unknown.status).toBe(404);
  });
});
