/**
 * Delivery assignment, tracking and earnings (delivery-system Part 58
 * follow-up, Slice C) — feasibility windows, nearest-partner offer/accept/
 * reject/pickup/deliver, admin reassignment, and idempotent earnings
 * crediting. No batching, no Google Routes call — see delivery-feasibility.ts
 * and delivery-assignment.ts for why.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Several tests here chain many sequential round-trips (checkout, two status
// transitions, an assignment scan) against a remote Neon instance, and the
// heaviest builds *two* ready orders before it can assert anything — roughly
// double the network cost of anything else in the suite. This has to stay
// above the global budget in vitest.config.ts, not below it: when the global
// went to 90s this override was still pinned at 60s and silently capped the
// file, which is what failed here.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 90_000 });

import { db } from "@/server/db";
import { deliveryEarningsConfig, orders, type Order } from "@/server/db/schema";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  getDeliveryOrderForOrder,
  markDelivered,
  markPickedUp,
  reassignOrder,
  rejectDeliveryOffer,
} from "@/server/services/delivery-assignment";
import {
  creditDeliveryEarnings,
  getActiveEarningsConfig,
  getPartnerEarningsSummary,
  setEarningsConfig,
} from "@/server/services/delivery-earnings";
import { getFeasibleDeliveryWindows } from "@/server/services/delivery-feasibility";
import { goOnline } from "@/server/services/delivery-partners";
import { addToCart } from "@/server/services/cart";
import { checkout, updateOrderStatus } from "@/server/services/orders";
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

beforeEach(resetDatabase);

const SHOP_LAT = 18.5;
const SHOP_LNG = 73.85;
/** ~1 degree latitude is ~111 km — used to place a partner a known distance from the shop. */
const kmToLatDegrees = (km: number) => km / 111;

async function setupReadyOrder(options: {
  preparationTimeMinutes?: number;
  customerCoords?: { latitude: number; longitude: number } | null;
} = {}): Promise<{ order: Order; ownerId: string; customerId: string; shopId: string }> {
  const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, {
    status: "APPROVED",
    latitude: SHOP_LAT,
    longitude: SHOP_LNG,
    preparationTimeMinutes: options.preparationTimeMinutes ?? 15,
  });
  const shopProduct = await createShopProduct(shop.id, product.id, {
    onlinePricePaise: 7000,
    onlineSaleEnabled: true,
  });

  await addToCart(customer.id, shopProduct.id, 1);
  const { orders: created } = await checkout({
    userId: customer.id,
    requestId: `req-${customer.id}`,
    addressId: null,
  });
  let order = created[0];

  if (options.customerCoords !== null) {
    const coords = options.customerCoords ?? { latitude: SHOP_LAT, longitude: SHOP_LNG };
    [order] = await db
      .update(orders)
      .set({
        deliveryAddressSnapshot: {
          line1: "1 Test Road",
          city: "Pune",
          pincode: "411001",
          latitude: String(coords.latitude),
          longitude: String(coords.longitude),
        },
      })
      .where(eq(orders.id, order.id))
      .returning();
  }

  const actor = { id: owner.id, role: "SHOP_OWNER" as const };
  order = await updateOrderStatus(order.id, "PREPARING", actor);
  order = await updateOrderStatus(order.id, "READY", actor);

  return { order, ownerId: owner.id, customerId: customer.id, shopId: shop.id };
}

describe("getFeasibleDeliveryWindows", () => {
  it("offers only SCHEDULED when nobody is online", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { latitude: SHOP_LAT, longitude: SHOP_LNG });

    const result = await getFeasibleDeliveryWindows(shop.id);
    expect(result).toEqual({
      EXPRESS_30: false,
      STANDARD_60: false,
      SCHEDULED: true,
      nearestPartnerDistanceKm: null,
      estimatedMinutes: null,
    });
  });

  it("offers EXPRESS_30 when an online partner is right next to the shop", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, {
      latitude: SHOP_LAT,
      longitude: SHOP_LNG,
      preparationTimeMinutes: 15,
    });
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, {
      status: "APPROVED",
      isOnline: true,
      latitude: SHOP_LAT,
      longitude: SHOP_LNG,
      operatingRadiusKm: 10,
    });

    const result = await getFeasibleDeliveryWindows(shop.id);
    expect(result.EXPRESS_30).toBe(true);
    expect(result.STANDARD_60).toBe(true);
    expect(result.SCHEDULED).toBe(true);
    expect(result.nearestPartnerDistanceKm).toBeCloseTo(0, 1);
  });

  it("drops EXPRESS_30 but keeps STANDARD_60 when the nearest partner is far but in range", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, {
      latitude: SHOP_LAT,
      longitude: SHOP_LNG,
      preparationTimeMinutes: 15,
    });
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    // ~13.3km away → 40 min travel at the 20km/h assumption + 15 min prep = 55 min.
    await createDeliveryPartner(riderUser.id, {
      status: "APPROVED",
      isOnline: true,
      latitude: SHOP_LAT + kmToLatDegrees(13.3),
      longitude: SHOP_LNG,
      operatingRadiusKm: 50,
    });

    const result = await getFeasibleDeliveryWindows(shop.id);
    expect(result.EXPRESS_30).toBe(false);
    expect(result.STANDARD_60).toBe(true);
  });

  it("excludes a partner outside their own operating radius", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { latitude: SHOP_LAT, longitude: SHOP_LNG });
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, {
      status: "APPROVED",
      isOnline: true,
      latitude: SHOP_LAT + kmToLatDegrees(10),
      longitude: SHOP_LNG,
      operatingRadiusKm: 2, // shop is ~10km away, outside this partner's own range
    });

    const result = await getFeasibleDeliveryWindows(shop.id);
    expect(result.EXPRESS_30).toBe(false);
    expect(result.STANDARD_60).toBe(false);
    expect(result.nearestPartnerDistanceKm).toBeNull();
  });
});

describe("assignNearestPartner", () => {
  it("offers the order to the nearest eligible online partner", async () => {
    const { order, ownerId } = await setupReadyOrder();
    const near = await createUser({ role: "DELIVERY_PARTNER" });
    const nearPartner = await createDeliveryPartner(near.id, {
      isOnline: true,
      latitude: SHOP_LAT,
      longitude: SHOP_LNG,
      operatingRadiusKm: 20,
    });
    const far = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(far.id, {
      isOnline: true,
      latitude: SHOP_LAT + kmToLatDegrees(15),
      longitude: SHOP_LNG,
      operatingRadiusKm: 20,
    });

    const assignment = await assignNearestPartner(order.id, { id: ownerId, role: "SHOP_OWNER" });
    expect(assignment.status).toBe("OFFERED");
    expect(assignment.deliveryPartnerId).toBe(nearPartner.id);
  });

  it("throws when the order is not READY", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { latitude: SHOP_LAT, longitude: SHOP_LNG });
    const customer = await createUser({ role: "CUSTOMER" });
    const [order] = await db
      .insert(orders)
      .values({
        orderNumber: "TEST-0001",
        userId: customer.id,
        shopId: shop.id,
        status: "CONFIRMED",
        subtotalPaise: 1000,
        totalPaise: 1000,
      })
      .returning();

    await expect(
      assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("throws when nobody is available", async () => {
    const { order, ownerId } = await setupReadyOrder();
    await expect(
      assignNearestPartner(order.id, { id: ownerId, role: "SHOP_OWNER" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("never assigns a partner already carrying an active delivery", async () => {
    const { order: orderA, ownerId } = await setupReadyOrder();
    const { order: orderB } = await setupReadyOrder();
    const rider = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(rider.id, {
      isOnline: true,
      latitude: SHOP_LAT,
      longitude: SHOP_LNG,
      operatingRadiusKm: 20,
    });

    await assignNearestPartner(orderA.id, { id: ownerId, role: "SHOP_OWNER" });
    await expect(
      assignNearestPartner(orderB.id, { id: ownerId, role: "SHOP_OWNER" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("full delivery lifecycle", () => {
  it("moves offer -> accept -> pickup -> deliver, updating the order and crediting earnings exactly once", async () => {
    const { order, ownerId } = await setupReadyOrder({
      customerCoords: { latitude: SHOP_LAT + kmToLatDegrees(4), longitude: SHOP_LNG },
    });
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, {
      isOnline: true,
      latitude: SHOP_LAT,
      longitude: SHOP_LNG,
      operatingRadiusKm: 20,
    });

    const offer = await assignNearestPartner(order.id, { id: ownerId, role: "SHOP_OWNER" });

    // Wrong user cannot act on someone else's offer.
    const stranger = await createUser({ role: "DELIVERY_PARTNER" });
    await expect(acceptDeliveryOffer(offer.id, stranger.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const accepted = await acceptDeliveryOffer(offer.id, riderUser.id);
    expect(accepted.status).toBe("ACCEPTED");

    const actor = { id: riderUser.id, role: "DELIVERY_PARTNER" as const };
    const pickedUp = await markPickedUp(offer.id, actor);
    expect(pickedUp.status).toBe("PICKED_UP");

    const [orderAfterPickup] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(orderAfterPickup.status).toBe("OUT_FOR_DELIVERY");

    const delivered = await markDelivered(offer.id, actor);
    expect(delivered.status).toBe("DELIVERED");

    const [orderAfterDelivery] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(orderAfterDelivery.status).toBe("DELIVERED");

    const config = await getActiveEarningsConfig();
    const summary = await getPartnerEarningsSummary(
      (await getDeliveryOrderForOrder(order.id))!.deliveryPartnerId,
    );
    expect(summary.deliveryCount).toBe(1);
    expect(summary.totalPaise).toBeGreaterThanOrEqual(config.baseFeePaise);

    // Re-crediting the same delivery must not pay out twice.
    const again = await creditDeliveryEarnings(offer.id);
    const summaryAfter = await getPartnerEarningsSummary(delivered.deliveryPartnerId);
    expect(summaryAfter.deliveryCount).toBe(1);
    expect(summaryAfter.totalPaise).toBe(again.totalPaise);
  });

  it("rejecting an offer frees it up for reassignment", async () => {
    const { order, ownerId } = await setupReadyOrder();
    // Placed further out so a strictly closer rider (below) is the
    // unambiguous pick once reassignment runs — rejection alone doesn't
    // exclude a rider from future offers in Phase 1, so this isolates
    // "reassignment picks the nearest eligible partner" from that.
    const riderA = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderA.id, {
      isOnline: true,
      latitude: SHOP_LAT + kmToLatDegrees(3),
      longitude: SHOP_LNG,
      operatingRadiusKm: 20,
    });

    const offer = await assignNearestPartner(order.id, { id: ownerId, role: "SHOP_OWNER" });
    expect(offer.deliveryPartnerId).not.toBeNull();
    const rejected = await rejectDeliveryOffer(offer.id, riderA.id, "Too far");
    expect(rejected.status).toBe("REJECTED");

    const riderB = await createUser({ role: "DELIVERY_PARTNER" });
    const riderBPartner = await createDeliveryPartner(riderB.id, {
      isOnline: true,
      latitude: SHOP_LAT,
      longitude: SHOP_LNG,
      operatingRadiusKm: 20,
    });

    const reassigned = await reassignOrder(order.id, { id: ownerId, role: "SHOP_OWNER" }, "retry");
    expect(reassigned.status).toBe("OFFERED");
    expect(reassigned.deliveryPartnerId).toBe(riderBPartner.id);
  });
});

describe("delivery earnings config", () => {
  it("bootstraps a default config on first read", async () => {
    const config = await getActiveEarningsConfig();
    expect(config.isActive).toBe(true);
    expect(config.baseFeePaise).toBeGreaterThan(0);
  });

  it("deactivates the previous config when a new one is set", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const first = await getActiveEarningsConfig();
    const updated = await setEarningsConfig(
      { baseFeePaise: 3000, perKmFeePaise: 1000 },
      { id: admin.id, role: "ADMIN" },
    );

    expect(updated.baseFeePaise).toBe(3000);
    const active = await getActiveEarningsConfig();
    expect(active.id).toBe(updated.id);

    const [prevRow] = await db
      .select()
      .from(deliveryEarningsConfig)
      .where(eq(deliveryEarningsConfig.id, first.id));
    expect(prevRow.isActive).toBe(false);
  });

  it("rejects a negative fee", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await expect(
      setEarningsConfig({ baseFeePaise: -1, perKmFeePaise: 100 }, { id: admin.id, role: "ADMIN" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("delivery-partner online status", () => {
  it("only lets an APPROVED partner go online", async () => {
    const user = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(user.id, { status: "REGISTERED" });

    await expect(goOnline(user.id, SHOP_LAT, SHOP_LNG)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
