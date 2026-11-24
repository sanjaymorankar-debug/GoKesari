/**
 * Hyperlocal Delivery Management System (docs/hdms-2026-11): allocation, partner bookings through the
 * gateway (sandbox simulator MOCK — no real partner API is reachable or integrated), webhooks, tracking,
 * cancellations, failed delivery / return, pricing split into the shop wallet, settlements and the
 * internal channels (shop rider, GoKesari rider). Real PostgreSQL, like every integration test here.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 90_000 });

import { db } from "@/server/db";
import {
  deliveryAllocationRuns,
  deliveryApiLogs,
  deliveryBookings,
  deliveryEvents,
  deliveryPricingRules,
  deliveryProviders,
  deliveryQuotes,
  deliveryWebhookLogs,
  deliveryZones,
  productDeliveryAttributes,
} from "@/server/db/hdms-schema";
import { featureFlags, orderItems, orders, platformSettings, shopDeliveryStaff, shops } from "@/server/db/schema";
import { allocateOrder } from "@/server/delivery/allocation";
import { cancelBooking, pollActiveBookings } from "@/server/delivery/bookings";
import { listProviderViews, updateProvider, updateShopRiderProfile } from "@/server/delivery/admin";
import { createSettlement, markSettlementPaid, reconcileSettlement } from "@/server/delivery/settlements";
import { handleDeliveryWebhook } from "@/server/delivery/webhooks";
import { mockBookCallCount, resetMock, setMockBehaviour, signMockWebhook } from "@/server/delivery/providers/mock";
import { encryptCredentials } from "@/server/integrations/credentials";
import { dispatchReadyOrder } from "@/server/services/delivery-assignment";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { walletCollectionFor } from "@/server/services/finance";
import { cancelOrder, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache } from "@/server/services/settings";
import {
  createCategory,
  createDeliveryPartner,
  createOrder,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  openRiderAvailabilityGate,
  resetDatabase,
  turnRiderZoningOff,
} from "../helpers/fixtures";

const BANER = { lat: 18.559, lng: 73.7868 };
const NEAR_BANER = { lat: 18.566, lng: 73.792 }; // ~1 km
const SECRET = "whsec_test_123";

async function setRule(key: string, value: Record<string, unknown>) {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
  clearRuleCache();
}

async function seedDeliveryMasters(opts: { flag?: boolean } = {}) {
  await db.delete(deliveryApiLogs);
  await db.delete(deliveryWebhookLogs);
  await db.execute(sql`DELETE FROM delivery_providers`);
  await db.execute(sql`DELETE FROM delivery_zones`);
  await db.insert(deliveryProviders).values([
    { code: "MOCK", name: "Sandbox simulator", enabled: true, priority: 90, timeoutMs: 800, capabilities: { integrated: true, maxDistanceKm: 20, maxWeightKg: 25, refrigerated: true, sandboxOnly: true }, webhookSecretEncrypted: encryptCredentials({ secret: SECRET }) },
    { code: "SHADOWFAX", name: "Shadowfax", enabled: false, priority: 30, capabilities: { integrated: false } },
  ]);
  const [zone] = await db
    .insert(deliveryZones)
    .values({ code: "PUN-BANER", name: "Baner", city: "Pune", centerLat: String(BANER.lat), centerLng: String(BANER.lng), radiusM: 3000 })
    .returning();
  await db.insert(deliveryPricingRules).values({ name: "Pune default", priority: 1000, commercialModel: "SHARED", shopSharePercent: 50, peakWindows: [] });
  if (opts.flag !== false) {
    await db.insert(featureFlags).values({ key: "hdms_enabled", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  }
  clearFeatureFlagCache();
  // GoKesari riders first, then partners after 1 failed rider attempt; fast circuit for tests.
  await setRule("deliveryAllocation", { externalAfterRiderAttempts: 1, circuitFailureThreshold: 2, quoteTimeoutMs: 800 });
  resetMock();
  return zone;
}

async function readyOrder(opts: { drop?: { lat: number; lng: number }; pincode?: string; window?: "EXPRESS_30" | "STANDARD_60" | "SCHEDULED"; choice?: "OWN_STAFF" | "GOKESARI_PARTNER" } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { latitude: BANER.lat, longitude: BANER.lng });
  if (opts.choice) await db.update(shops).set({ deliveryChoice: opts.choice }).where(eq(shops.id, shop.id));
  const customer = await createUser();
  const order = await createOrder(customer.id, shop.id, { status: "READY", subtotalPaise: 30000 });
  const drop = opts.drop ?? NEAR_BANER;
  await db
    .update(orders)
    .set({
      deliveryWindow: opts.window ?? "STANDARD_60",
      deliveryAddressSnapshot: { line1: "5 Test Lane", city: "Pune", pincode: opts.pincode ?? "411045", latitude: String(drop.lat), longitude: String(drop.lng) },
    })
    .where(eq(orders.id, order.id));
  return { owner, shop, customer, order };
}

async function orderStatus(orderId: string) {
  const [o] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return o.status;
}

function webhook(events: Record<string, unknown>[], secret = SECRET) {
  const raw = JSON.stringify({ events });
  const headers = new Headers({ "x-mock-signature": signMockWebhook(raw, secret) });
  return handleDeliveryWebhook("mock", raw, headers);
}

beforeEach(async () => {
  await resetDatabase();
});

describe("HDMS allocation and partner booking", () => {
  it("books the sandbox partner for a ready order, records quotes, pricing split, and assigns the order", async () => {
    await seedDeliveryMasters();
    const { order } = await readyOrder();
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r.outcome).toBe("BOOKED");
    expect(r.providerCode).toBe("MOCK");
    expect(r.booking?.status).toBe("ASSIGNED");
    expect(r.booking?.externalRef).toMatch(/^MOCK-/);
    expect(r.booking?.pricing?.model).toBe("SHARED");
    expect(r.booking!.pricing!.shopPaise + r.booking!.pricing!.customerPaise + r.booking!.pricing!.gokesariPaise).toBe(r.booking!.pricing!.totalFeePaise);
    expect(await orderStatus(order.id)).toBe("ASSIGNED");
    const runs = await db.select().from(deliveryAllocationRuns).where(eq(deliveryAllocationRuns.orderId, order.id));
    expect(runs).toHaveLength(1);
    const quotes = await db.select().from(deliveryQuotes).where(eq(deliveryQuotes.runId, runs[0].id));
    expect(quotes.find((q) => q.providerCode === "MOCK")?.serviceable).toBe(true);
  });

  it("does nothing while the hdms_enabled flag is off", async () => {
    await seedDeliveryMasters({ flag: false });
    const { order } = await readyOrder();
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r.outcome).toBe("SKIPPED");
    expect(await db.select().from(deliveryBookings)).toHaveLength(0);
    expect(await orderStatus(order.id)).toBe("READY");
  });

  it("prevents duplicate bookings when two allocations race", async () => {
    await seedDeliveryMasters();
    const { order } = await readyOrder();
    const [a, b] = await Promise.all([
      allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true }),
      allocateOrder(order.id, "MANUAL_SHOP", { externalOnly: true }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toContain("BOOKED");
    expect(outcomes.filter((o) => o === "BOOKED")).toHaveLength(1);
    const rows = await db.select().from(deliveryBookings).where(eq(deliveryBookings.orderId, order.id));
    expect(rows).toHaveLength(1);
    expect(mockBookCallCount(rows[0].idempotencyKey)).toBe(1);
  });

  it("records a serviceability failure and leaves the order ready", async () => {
    await seedDeliveryMasters();
    const { order } = await readyOrder({ pincode: "000000" });
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r.outcome).toBe("NO_CANDIDATE");
    expect(r.candidates.find((c) => c.providerCode === "MOCK")?.reason).toMatch(/not serviced/i);
    expect(await orderStatus(order.id)).toBe("READY");
  });

  it("times out a slow partner quote, logs it, and does not book", async () => {
    await seedDeliveryMasters();
    setMockBehaviour({ timeoutOn: "quote" });
    const { order } = await readyOrder();
    const started = Date.now();
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.outcome).toBe("NO_CANDIDATE");
    expect(r.candidates[0].reason).toMatch(/TIMEOUT/);
    const logs = await db.select().from(deliveryApiLogs).where(eq(deliveryApiLogs.providerCode, "MOCK"));
    expect(logs.some((l) => !l.ok && /TIMEOUT/.test(l.error ?? ""))).toBe(true);
  });

  it("opens the circuit after repeated partner outages and skips the partner until reset", async () => {
    await seedDeliveryMasters();
    setMockBehaviour({ unavailableOn: "book" });
    const { order } = await readyOrder();
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r.outcome).toBe("ERROR");
    const [p] = await db.select().from(deliveryProviders).where(eq(deliveryProviders.code, "MOCK"));
    expect(p.circuitState).toBe("OPEN");
    expect(await orderStatus(order.id)).toBe("READY");
    setMockBehaviour({});
    const again = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(again.outcome).toBe("NO_CANDIDATE");
    expect(again.candidates[0].reason).toMatch(/circuit open/i);
    await updateProvider("MOCK", { resetCircuit: true }, (await createUser({ role: "ADMIN" })).id);
    expect((await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true })).outcome).toBe("BOOKED");
  });

  it("refuses a partner without refrigeration for a chilled item, and a suspended zone", async () => {
    const zone = await seedDeliveryMasters();
    await db.update(deliveryProviders).set({ capabilities: { integrated: true, refrigerated: false, sandboxOnly: true } }).where(eq(deliveryProviders.code, "MOCK"));
    const { order, shop } = await readyOrder();
    const cat = await createCategory();
    const product = await createProduct(cat.id, { name: "Paneer" });
    const sp = await createShopProduct(shop.id, product.id);
    await db.insert(orderItems).values({ orderId: order.id, shopProductId: sp.id, productNameSnapshot: "Paneer", unitSnapshot: "pc", unitPricePaise: 30000, quantityMilli: 1000, lineTotalPaise: 30000 });
    await db.insert(productDeliveryAttributes).values({ productId: product.id, refrigerationRequired: true, perishable: true, weightGrams: 200 });
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r.outcome).toBe("NO_CANDIDATE");
    expect(r.candidates[0].reason).toMatch(/refrigerated/i);

    await db.update(deliveryZones).set({ status: "SUSPENDED", suspendedReason: "Heavy rain" }).where(eq(deliveryZones.id, zone.id));
    const r2 = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r2.detail).toMatch(/suspended: Heavy rain/);
  });

  it("leaves scheduled (subscription / slot) orders to the scheduled workflow", async () => {
    await seedDeliveryMasters();
    const { order } = await readyOrder({ window: "SCHEDULED" });
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r.outcome).toBe("SKIPPED");
    expect(r.detail).toMatch(/scheduled/i);
  });
});

describe("HDMS internal channels", () => {
  it("prefers an available shop rider when the shop delivers with its own staff", async () => {
    await seedDeliveryMasters();
    const { order, shop } = await readyOrder({ choice: "OWN_STAFF" });
    await db.insert(shopDeliveryStaff).values({ shopId: shop.id, name: "Ravi", phoneE164: "+919800000001" });
    const r = await allocateOrder(order.id, "MANUAL_ADMIN");
    expect(r.outcome).toBe("INTERNAL");
    expect(r.channel).toBe("SHOP_RIDER");
    expect(await db.select().from(deliveryBookings)).toHaveLength(0);
  });

  it("offers a free GoKesari rider before any partner", async () => {
    await seedDeliveryMasters();
    await openRiderAvailabilityGate();
    await turnRiderZoningOff();
    const { order } = await readyOrder();
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: BANER.lat + 0.001, longitude: BANER.lng });
    const r = await allocateOrder(order.id, "MANUAL_ADMIN");
    expect(r.outcome).toBe("INTERNAL");
    expect(r.channel).toBe("GOKESARI_RIDER");
    expect(await db.select().from(deliveryBookings)).toHaveLength(0);
  });

  it("falls back to a partner from the rider search when no GoKesari rider is free", async () => {
    await seedDeliveryMasters();
    const { order } = await readyOrder();
    const offer = await dispatchReadyOrder(order.id, { id: null, role: null }, "AUTO_READY");
    expect(offer).toBeNull();
    const [b] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.orderId, order.id));
    expect(b?.providerCode).toBe("MOCK");
    expect(await orderStatus(order.id)).toBe("ASSIGNED");
    // A later sweep does not offer the order to a rider again.
    expect(await dispatchReadyOrder(order.id, { id: null, role: null }, "SWEEP")).toBeNull();
  });

  it("shop updates its own rider's availability and ID proof (last 4 only), not another shop's", async () => {
    await seedDeliveryMasters();
    const { shop } = await readyOrder();
    const other = await readyOrder();
    const [staff] = await db.insert(shopDeliveryStaff).values({ shopId: shop.id, name: "Asha", phoneE164: "+919800000002" }).returning();
    const row = await updateShopRiderProfile(shop.id, staff.id, { isAvailable: false, vehicleType: "SCOOTER", idDocumentType: "DRIVING_LICENCE", idDocumentNumber: "MH12 20110012345" });
    expect(row.isAvailable).toBe(false);
    expect(row.idDocumentLast4).toBe("2345");
    expect(row.kycStatus).toBe("SUBMITTED");
    await expect(updateShopRiderProfile(other.shop.id, staff.id, { isAvailable: true })).rejects.toThrow(/not found/i);
  });
});

describe("HDMS webhooks, tracking and outcomes", () => {
  async function booked() {
    await seedDeliveryMasters();
    const ctx = await readyOrder();
    const r = await allocateOrder(ctx.order.id, "MANUAL_ADMIN", { externalOnly: true });
    expect(r.outcome).toBe("BOOKED");
    return { ...ctx, booking: r.booking! };
  }

  it("moves the order through pickup and delivery from signed webhooks; duplicates and late events change nothing", async () => {
    const { order, booking } = await booked();
    const ref = booking.externalRef!;
    let res = await webhook([{ id: "e1", ref, status: "PICKED_UP", riderName: "Sandbox Rider", riderPhone: "+919812345678", lat: 18.56, lng: 73.79, etaMinutes: 12 }]);
    expect(res.status).toBe(200);
    expect(await orderStatus(order.id)).toBe("PICKED_UP");
    const [b1] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, booking.id));
    expect(b1.riderPhoneMasked).toBe("+91 98XXXXXX78");
    expect(Number(b1.riderLat)).toBeCloseTo(18.56);
    expect(b1.etaAt).not.toBeNull();

    res = await webhook([{ id: "e1", ref, status: "PICKED_UP" }]);
    expect(res.body.results).toEqual([{ eventId: "e1", result: "DUPLICATE" }]);

    res = await webhook([{ id: "e0", ref, status: "ASSIGNED" }]);
    expect((res.body.results as { result: string }[])[0].result).toBe("IGNORED:ASSIGNED");
    expect(await orderStatus(order.id)).toBe("PICKED_UP");

    await webhook([{ id: "e2", ref, status: "IN_TRANSIT" }]);
    expect(await orderStatus(order.id)).toBe("OUT_FOR_DELIVERY");
    await webhook([{ id: "e3", ref, status: "DELIVERED", feePaise: 4100 }]);
    expect(await orderStatus(order.id)).toBe("DELIVERED");
    const events = await db.select().from(deliveryEvents).where(eq(deliveryEvents.bookingId, booking.id));
    expect(events.length).toBeGreaterThanOrEqual(5);
  });

  it("rejects a webhook with a wrong signature and logs it without personal data", async () => {
    const { booking } = await booked();
    const res = await webhook([{ id: "x1", ref: booking.externalRef, status: "DELIVERED", riderPhone: "+919800000000" }], "wrong-secret");
    expect(res.status).toBe(401);
    const logs = await db.select().from(deliveryWebhookLogs);
    expect(logs[0].signatureValid).toBe(false);
    expect(JSON.stringify(logs[0].payload)).not.toContain("+919800000000");
  });

  it("partner cancels before pickup: order back to ready and the engine tries again", async () => {
    const { order, booking } = await booked();
    await webhook([{ id: "c1", ref: booking.externalRef, status: "CANCELLED", reason: "No rider" }]);
    const [b] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, booking.id));
    expect(b.status).toBe("CANCELLED");
    expect(b.cancelledBy).toBe("PROVIDER");
    expect(await orderStatus(order.id)).toBe("READY");
    const runs = await db.select().from(deliveryAllocationRuns).where(and(eq(deliveryAllocationRuns.orderId, order.id), eq(deliveryAllocationRuns.trigger, "REALLOCATE")));
    expect(runs).toHaveLength(1); // MOCK excluded → no other partner left in this test
  });

  it("customer cancellation cancels the partner booking", async () => {
    const { order, customer, booking } = await booked();
    await cancelOrder(order.id, { id: customer.id, role: "CUSTOMER" }, "Changed my mind");
    const [b] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, booking.id));
    expect(b.status).toBe("CANCELLED");
    expect(b.cancelledBy).toBe("CUSTOMER");
  });

  it("shop cancellation cancels the partner booking", async () => {
    const { order, owner, booking } = await booked();
    await cancelOrder(order.id, { id: owner.id, role: "SHOP_OWNER" }, "Out of stock");
    const [b] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, booking.id));
    expect(b.cancelledBy).toBe("SHOP");
  });

  it("refuses to cancel with the partner after pickup, and a refused cancel keeps the booking", async () => {
    const { booking } = await booked();
    setMockBehaviour({ refuseCancel: true });
    await expect(cancelBooking(booking.id, "ADMIN", "test")).rejects.toThrow(/refused/i);
    await webhook([{ id: "p1", ref: booking.externalRef, status: "PICKED_UP" }]);
    await expect(cancelBooking(booking.id, "ADMIN", "test")).rejects.toThrow(/picked up/i);
  });

  it("failed delivery after pickup, then return to shop", async () => {
    const { order, booking } = await booked();
    await webhook([{ id: "f1", ref: booking.externalRef, status: "PICKED_UP" }]);
    await webhook([{ id: "f2", ref: booking.externalRef, status: "FAILED", reason: "Customer not reachable" }]);
    expect(await orderStatus(order.id)).toBe("FAILED");
    await webhook([{ id: "f3", ref: booking.externalRef, status: "RETURNED" }]);
    expect(await orderStatus(order.id)).toBe("RETURNED");
  });

  it("polling advances a sandbox booking (live tracking without webhooks)", async () => {
    const { booking } = await booked();
    // Pretend the booking is 5 minutes old so the simulator reports progress.
    const old = `MOCK-${(Date.now() - 5 * 60_000).toString(36).toUpperCase()}-ABCDEF123456`;
    await db.update(deliveryBookings).set({ externalRef: old }).where(eq(deliveryBookings.id, booking.id));
    const r = await pollActiveBookings();
    expect(r.polled).toBe(1);
    const [b] = await db.select().from(deliveryBookings).where(eq(deliveryBookings.id, booking.id));
    expect(["AT_PICKUP", "PICKED_UP", "IN_TRANSIT"]).toContain(b.status);
    expect(b.riderName).toBe("Sandbox Rider");
  });

  it("charges the shop its share of a partner delivery through the existing shop wallet", async () => {
    const { order, booking } = await booked();
    await setRule("shopWallet", { enabled: true });
    await webhook([{ id: "w1", ref: booking.externalRef, status: "DELIVERED" }]);
    expect(await orderStatus(order.id)).toBe("DELIVERED");
    const collection = await walletCollectionFor(order.id);
    expect(collection.shopDeliveryChargePaise).toBe(booking.pricing!.shopPaise);
    expect(collection.shopDeliveryChargePaise).toBeGreaterThan(0);
  });
});

describe("HDMS settlements and credential security", () => {
  it("reconciles a partner invoice against delivered bookings", async () => {
    await seedDeliveryMasters();
    const admin = await createUser({ role: "ADMIN" });
    const { order } = await readyOrder();
    const r = await allocateOrder(order.id, "MANUAL_ADMIN", { externalOnly: true });
    await webhook([{ id: "s1", ref: r.booking!.externalRef, status: "DELIVERED", feePaise: 4000 }]);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const s = await createSettlement("MOCK", today, today, admin.id);
    expect(s.bookingCount).toBe(1);
    expect(s.expectedPaise).toBe(4000);
    const mismatch = await reconcileSettlement(s.id, `reference,amount\n${r.booking!.externalRef},41.00\nMOCK-UNKNOWN,10`, "INV-1");
    expect(mismatch.status).toBe("DISPUTED");
    expect(mismatch.differencePaise).toBe(1100);
    const clean = await reconcileSettlement(s.id, `${r.booking!.externalRef},40`, "INV-1b");
    expect(clean.status).toBe("RECONCILED");
    expect((await markSettlementPaid(s.id, "UTR123")).status).toBe("PAID");
  });

  it("stores partner credentials encrypted and never returns them; an unintegrated partner cannot be enabled", async () => {
    await seedDeliveryMasters();
    const admin = await createUser({ role: "ADMIN" });
    await updateProvider("MOCK", { credentials: { apiKey: "sk_live_should_not_leak" }, webhookSecret: "new-secret" }, admin.id);
    const [row] = await db.select().from(deliveryProviders).where(eq(deliveryProviders.code, "MOCK"));
    expect(row.credentialsEncrypted).toMatch(/^v1:/);
    expect(row.credentialsEncrypted).not.toContain("sk_live_should_not_leak");
    const views = await listProviderViews();
    expect(JSON.stringify(views)).not.toContain("sk_live_should_not_leak");
    expect(views.find((v) => v.code === "MOCK")?.hasCredentials).toBe(true);
    await expect(updateProvider("SHADOWFAX", { enabled: true }, admin.id)).rejects.toThrow(/not integrated/i);
    await expect(updateProvider("MOCK", { environment: "PRODUCTION" }, admin.id)).rejects.toThrow(/SANDBOX/);
  });

  it("existing flow unchanged: a ready order with no partner booking still delivers by status change", async () => {
    await seedDeliveryMasters({ flag: false });
    const { order, owner } = await readyOrder();
    await updateOrderStatus(order.id, "OUT_FOR_DELIVERY", { id: owner.id, role: "SHOP_OWNER" });
    await updateOrderStatus(order.id, "DELIVERED", { id: owner.id, role: "SHOP_OWNER" });
    expect(await orderStatus(order.id)).toBe("DELIVERED");
    expect((await walletCollectionFor(order.id)).shopDeliveryChargePaise).toBe(0);
  });
});
