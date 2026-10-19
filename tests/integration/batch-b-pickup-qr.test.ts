/**
 * batch-2026-10 WS-B — F4.1.3 pickup by signed, single-use QR (rule pickupQr).
 * Flag off: the typed pickup code is the only way, unchanged.
 */
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as scanRoute } from "@/app/api/delivery-orders/[id]/pickup-scan/route";
import type { ServerEnv } from "@/lib/env";
import { db } from "@/server/db";
import {
  deliveryOrders,
  deliveryPickupScans,
  deliveryPickupTokens,
  notifications,
  orderItems,
  orders,
  platformSettings,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { acceptDeliveryOffer, assignNearestPartner, markPickedUp } from "@/server/services/delivery-assignment";
import { getPackingSlip } from "@/server/services/packing-slip";
import {
  buildPickupPayload,
  getPickupQrForOrder,
  pickupQrSecret,
  scanPickupQr,
  verifyPickupPayload,
} from "@/server/services/pickup-qr";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import {
  createCategory,
  createDeliveryPartner,
  createOrder,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  resetDatabase,
} from "../helpers/fixtures";

const SHOP = { latitude: 18.5, longitude: 73.85 };
const SECRET = "unit-test-secret-0123456789";
const ORDER_ID = "6f1c2f5e-8d4b-4c1a-9b7e-1234567890ab";
const GPS = { latitude: 18.5001, longitude: 73.8502, accuracyM: 12 };

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["pickupQr"]));
  clearRuleCache();
});

async function enableQr(overrides: Record<string, unknown> = {}) {
  const admin = await createUser({ role: "ADMIN" });
  await setRule("pickupQr", { enabled: true, ...overrides }, { id: admin.id, role: "ADMIN" });
}

/** A packed order, offered to and accepted by a rider (order ASSIGNED, pickup code issued). */
async function acceptedDelivery() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, SHOP);
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: 18.501, longitude: SHOP.longitude, operatingRadiusKm: 10 });
  const customer = await createUser({ name: "Asha Kulkarni" });
  const order = await createOrder(customer.id, shop.id, { status: "READY" });
  await db
    .update(orders)
    .set({ deliveryAddressSnapshot: { line1: "Flat 4, Lane 2", area: "Kothrud", city: "Pune", pincode: "411038" } })
    .where(eq(orders.id, order.id));
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shopProduct = await createShopProduct(shop.id, product.id, { onlinePricePaise: 7000 });
  await db.insert(orderItems).values({
    orderId: order.id,
    shopProductId: shopProduct.id,
    productNameSnapshot: "Cow Milk",
    unitSnapshot: "L",
    unitPricePaise: 7000,
    quantityMilli: 2000,
    lineTotalPaise: 14000,
  });
  const offer = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
  const accepted = await acceptDeliveryOffer(offer.id, riderUser.id);
  return { owner, shop, riderUser, partner, customer, order, delivery: accepted };
}

const riderActor = (u: { id: string }) => ({ id: u.id, role: "DELIVERY_PARTNER" as const });

describe("QR signing", () => {
  it("TC-B26-B-014 a signed payload verifies; the order id, nonce and expiry come back", () => {
    const exp = new Date(Date.now() + 3600_000);
    const payload = buildPickupPayload(ORDER_ID, "A".repeat(22), exp, SECRET);
    const v = verifyPickupPayload(payload, SECRET);
    expect(v).toMatchObject({ ok: true, orderId: ORDER_ID, nonce: "A".repeat(22) });
  });

  it("TC-B26-B-015 any tampering is rejected: changed order id, nonce, expiry or signature, or another secret", () => {
    const exp = new Date(Date.now() + 3600_000);
    const payload = buildPickupPayload(ORDER_ID, "A".repeat(22), exp, SECRET);
    const parts = payload.split(".");
    const tamper = (i: number, value: string) => parts.map((p, j) => (j === i ? value : p)).join(".");
    expect(verifyPickupPayload(tamper(1, "6f1c2f5e-8d4b-4c1a-9b7e-1234567890ac"), SECRET)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyPickupPayload(tamper(2, "B".repeat(22)), SECRET)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyPickupPayload(tamper(3, String(Number(parts[3]) + 999)), SECRET)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyPickupPayload(tamper(4, "x".repeat(22)), SECRET)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyPickupPayload(payload, "another-secret-0123456789")).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyPickupPayload("hello", SECRET)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifyPickupPayload(`GKP1.${ORDER_ID}.short.1.sig`, SECRET)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("TC-B26-B-016 an expired payload is refused even with a good signature", () => {
    const payload = buildPickupPayload(ORDER_ID, "A".repeat(22), new Date(Date.now() - 1000), SECRET);
    expect(verifyPickupPayload(payload, SECRET)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("TC-B26-B-017 the secret: PICKUP_QR_SECRET; AUTH_SECRET stands in outside production only", () => {
    const base = { AUTH_SECRET: "auth-secret" } as ServerEnv;
    expect(pickupQrSecret({ ...base, NODE_ENV: "production", PICKUP_QR_SECRET: "qr-secret-0123456789" })).toBe("qr-secret-0123456789");
    expect(pickupQrSecret({ ...base, NODE_ENV: "production" })).toBeNull();
    expect(pickupQrSecret({ ...base, NODE_ENV: "development" })).toBe("auth-secret");
  });
});

describe("pickup QR on the shop's screens", () => {
  it("TC-B26-B-018 flag off: no QR is issued", async () => {
    const { order } = await acceptedDelivery();
    expect(await getPickupQrForOrder(order.id)).toBeNull();
    expect(await db.select().from(deliveryPickupTokens)).toHaveLength(0);
  });

  it("TC-B26-B-019 flag on: a packed order gets one stable QR (SVG) — only the nonce hash is stored", async () => {
    await enableQr();
    const { order } = await acceptedDelivery();
    const qr = await getPickupQrForOrder(order.id);
    expect(qr?.payload.startsWith(`GKP1.${order.id}.`)).toBe(true);
    expect(qr?.svg).toContain("<svg");
    expect((await getPickupQrForOrder(order.id))?.payload).toBe(qr?.payload);
    const tokens = await db.select().from(deliveryPickupTokens);
    expect(tokens).toHaveLength(1);
    expect(qr!.payload).not.toContain(tokens[0].nonceHash);
    // Not for an order that is not packed and waiting.
    await db.update(orders).set({ status: "PREPARING" }).where(eq(orders.id, order.id));
    expect(await getPickupQrForOrder(order.id)).toBeNull();
  });

  it("TC-B26-B-020 the packing slip: items, first name + area only, pickup code, QR — owner only", async () => {
    await enableQr();
    const { order, owner } = await acceptedDelivery();
    const slip = await getPackingSlip(order.id, { id: owner.id, role: "SHOP_OWNER" });
    expect(slip).toMatchObject({ orderNumber: order.orderNumber, customerFirstName: "Asha", customerArea: "Kothrud, Pune" });
    expect(slip.items).toEqual([{ name: "Cow Milk", quantity: expect.stringContaining("2"), note: null }]);
    expect(JSON.stringify(slip)).not.toContain("Flat 4");
    expect(slip.pickupCode).toMatch(/^\d{4}$/);
    expect(slip.qr?.svg).toContain("<svg");
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(getPackingSlip(order.id, { id: stranger.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("rider scans the QR", () => {
  it("TC-B26-B-021 a valid scan marks the order PICKED_UP, records time + GPS, spends the QR and tells the customer", async () => {
    await enableQr();
    const { order, riderUser, customer, delivery, partner } = await acceptedDelivery();
    const qr = await getPickupQrForOrder(order.id);
    const result = await scanPickupQr({ deliveryOrderId: delivery.id, actor: riderActor(riderUser), payload: qr!.payload, ...GPS });
    expect(result.delivery.status).toBe("PICKED_UP");
    expect(result.delivery).not.toHaveProperty("pickupCode");

    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("PICKED_UP");
    const [token] = await db.select().from(deliveryPickupTokens).where(eq(deliveryPickupTokens.orderId, order.id));
    expect(token.consumedAt).not.toBeNull();
    expect(token.consumedByPartnerId).toBe(partner.id);
    const [scan] = await db.select().from(deliveryPickupScans).where(eq(deliveryPickupScans.deliveryOrderId, delivery.id));
    expect(scan).toMatchObject({ outcome: "SUCCESS", latitude: "18.5001", longitude: "73.8502", accuracyM: 12 });
    expect(scan.scannedAt).toBeInstanceOf(Date);
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, customer.id), eq(notifications.type, NOTIFICATION_TYPES.ORDER_PICKED_UP)));
    expect(told).toHaveLength(1);
  });

  it("TC-B26-B-022 single use: a second scan of the same QR is refused", async () => {
    await enableQr();
    const { order, riderUser, delivery } = await acceptedDelivery();
    const qr = await getPickupQrForOrder(order.id);
    await scanPickupQr({ deliveryOrderId: delivery.id, actor: riderActor(riderUser), payload: qr!.payload, ...GPS });
    await expect(
      scanPickupQr({ deliveryOrderId: delivery.id, actor: riderActor(riderUser), payload: qr!.payload, ...GPS }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "ALREADY_USED", fallback: "PICKUP_CODE" } });
  });

  it("TC-B26-B-023 another rider cannot use it (403) and the attempt is recorded", async () => {
    await enableQr();
    const { order, delivery } = await acceptedDelivery();
    const qr = await getPickupQrForOrder(order.id);
    const otherUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(otherUser.id, { isOnline: true, latitude: 18.5, longitude: 73.85 });
    await expect(
      scanPickupQr({ deliveryOrderId: delivery.id, actor: riderActor(otherUser), payload: qr!.payload, ...GPS }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const scans = await db.select().from(deliveryPickupScans);
    expect(scans.map((s) => s.outcome)).toEqual(["WRONG_RIDER"]);
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, delivery.id));
    expect(row.status).toBe("ACCEPTED");
  });

  it("TC-B26-B-024 a tampered, foreign-order or expired QR is refused; the typed code still works afterwards", async () => {
    await enableQr();
    const { order, riderUser, delivery } = await acceptedDelivery();
    const qr = await getPickupQrForOrder(order.id);
    const actor = riderActor(riderUser);
    const tampered = qr!.payload.slice(0, -2) + (qr!.payload.endsWith("AA") ? "BB" : "AA");
    await expect(scanPickupQr({ deliveryOrderId: delivery.id, actor, payload: tampered })).rejects.toMatchObject({
      details: { reason: "BAD_SIGNATURE" },
    });
    const secret = pickupQrSecret()!;
    const foreign = buildPickupPayload(ORDER_ID, "A".repeat(22), new Date(Date.now() + 60_000), secret);
    await expect(scanPickupQr({ deliveryOrderId: delivery.id, actor, payload: foreign })).rejects.toMatchObject({
      details: { reason: "WRONG_ORDER" },
    });
    // The token's own expiry (rule tokenTtlMinutes) passes while the printed QR still looks valid.
    await db.update(deliveryPickupTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(deliveryPickupTokens.orderId, order.id));
    await expect(scanPickupQr({ deliveryOrderId: delivery.id, actor, payload: qr!.payload })).rejects.toMatchObject({
      details: { reason: "EXPIRED" },
    });

    // Fallback: the shop's 4-digit code, the existing path.
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, delivery.id));
    const picked = await markPickedUp(delivery.id, actor, row.pickupCode!);
    expect(picked.status).toBe("PICKED_UP");
    expect((await db.select().from(deliveryPickupScans)).map((s) => s.outcome).sort()).toEqual(["BAD_SIGNATURE", "EXPIRED", "WRONG_ORDER"]);
  });

  it("TC-B26-B-025 flag off: a scan is refused and the old code-only flow is unchanged (wrong code still refused)", async () => {
    const { riderUser, delivery } = await acceptedDelivery();
    const actor = riderActor(riderUser);
    await expect(scanPickupQr({ deliveryOrderId: delivery.id, actor, payload: "GKP1.x" })).rejects.toMatchObject({
      details: { reason: "DISABLED" },
    });
    await expect(markPickedUp(delivery.id, actor, "0000" === delivery.pickupCode ? "1111" : "0000")).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect((await markPickedUp(delivery.id, actor, delivery.pickupCode!)).status).toBe("PICKED_UP");
  });

  it("TC-B26-B-026 with requireGps on, a scan without location is refused (code fallback offered)", async () => {
    await enableQr({ requireGps: true });
    const { order, riderUser, delivery } = await acceptedDelivery();
    const qr = await getPickupQrForOrder(order.id);
    await expect(scanPickupQr({ deliveryOrderId: delivery.id, actor: riderActor(riderUser), payload: qr!.payload })).rejects.toMatchObject({
      details: { reason: "NO_GPS", fallback: "PICKUP_CODE" },
    });
  });

  it("TC-B26-B-027 route: 401 without a session, 403 for another rider, 200 for the rider with GPS", async () => {
    await enableQr();
    const { order, riderUser, delivery } = await acceptedDelivery();
    const qr = await getPickupQrForOrder(order.id);
    const send = () =>
      call(scanRoute, `/api/delivery-orders/${delivery.id}/pickup-scan`, {
        method: "POST",
        params: { id: delivery.id },
        body: { payload: qr!.payload, latitude: GPS.latitude, longitude: GPS.longitude },
      });
    expect((await send()).status).toBe(401);
    const other = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(other.id, { isOnline: true, latitude: 18.5, longitude: 73.85 });
    state.session = { user: { id: other.id, email: other.email, name: other.name, image: null, role: "DELIVERY_PARTNER", status: "ACTIVE" } };
    expect((await send()).status).toBe(403);
    state.session = { user: { id: riderUser.id, email: riderUser.email, name: riderUser.name, image: null, role: "DELIVERY_PARTNER", status: "ACTIVE" } };
    const ok = await send();
    expect(ok.status).toBe(200);
    expect(ok.body.delivery.status).toBe("PICKED_UP");
  });
});
