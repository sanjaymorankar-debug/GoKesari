/**
 * GA-005 — rider batching. With the rule on, a rider whose orders are all
 * still waiting for pickup can be offered another order that fits the trip:
 * pickup close by, drop in the same direction, every promise still kept.
 * The rider gets one ordered list of pickups then drops; each order keeps
 * its own delivery row and status.
 */
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { deliveryOrders, orders, platformSettings, shops } from "@/server/db/schema";
import {
  acceptDeliveryOffer,
  assignNearestPartner,
  getMyActiveDeliveryOrder,
  markPickedUp,
} from "@/server/services/delivery-assignment";
import {
  angleBetween,
  bearingDegrees,
  checkBatchCompatibility,
  getRiderTrip,
  planTrip,
  type TripMember,
} from "@/server/services/delivery-trips";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

const SHOP = { latitude: 18.5, longitude: 73.85 };
const north = (km: number) => ({ latitude: SHOP.latitude + km / 111, longitude: SHOP.longitude });
const east = (km: number) => ({ latitude: SHOP.latitude, longitude: SHOP.longitude + km / 105.5 });
let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["batching", "dispatch"]));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

async function enableBatching(over: Record<string, unknown> = {}) {
  await setRule("batching", { enabled: true, ...over }, admin);
}

async function shopAt(point: { latitude: number; longitude: number }, name = "Dairy") {
  const owner = await createUser({ role: "SHOP_OWNER" });
  return createShop(owner.id, { name, latitude: point.latitude, longitude: point.longitude });
}

async function readyOrderTo(shopId: string, drop: { latitude: number; longitude: number }, promisedInMinutes?: number) {
  const customer = await createUser();
  const order = await createOrder(customer.id, shopId, { status: "READY" });
  await db
    .update(orders)
    .set({
      deliveryAddressSnapshot: {
        line1: "1 Lane",
        line2: null,
        area: "Area",
        city: "Pune",
        pincode: "411001",
        latitude: String(drop.latitude),
        longitude: String(drop.longitude),
        landmark: null,
        deliveryInstructions: null,
      },
      promisedByAt: promisedInMinutes != null ? new Date(Date.now() + promisedInMinutes * 60_000) : null,
    })
    .where(eq(orders.id, order.id));
  return order;
}

async function riderAt(point: { latitude: number; longitude: number }) {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const partner = await createDeliveryPartner(user.id, { isOnline: true, latitude: point.latitude, longitude: point.longitude });
  return { user, partner };
}

/** A rider near the shop who has accepted one order going north. */
async function riderWithOneOrder() {
  const shop = await shopAt(SHOP);
  const rider = await riderAt(north(0.3));
  const first = await readyOrderTo(shop.id, north(3), 60);
  const offer = await assignNearestPartner(first.id, admin);
  await acceptDeliveryOffer(offer.id, rider.user.id);
  return { shop, rider, first, firstDelivery: offer };
}

describe("off by default", () => {
  it("a rider holding an order is not offered a second one", async () => {
    const { shop } = await riderWithOneOrder();
    const second = await readyOrderTo(shop.id, north(3.2), 60);
    await expect(assignNearestPartner(second.id, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("joining a trip", () => {
  it("offers a compatible order to the rider on a trip, ahead of an idle rider a little further away", async () => {
    await enableBatching();
    const { shop, rider, firstDelivery } = await riderWithOneOrder();
    await riderAt(north(0.9)); // idle, but 0.6 km further than the batched rider
    const second = await readyOrderTo(shop.id, north(3.5), 60);
    const offer = await assignNearestPartner(second.id, admin);
    expect(offer.deliveryPartnerId).toBe(rider.partner.id);
    expect(offer.tripId).not.toBeNull();

    const [firstRow] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, firstDelivery.id));
    expect(firstRow.tripId).toBe(offer.tripId);
  });

  it("prefers the idle rider when they are much nearer than the preference distance allows", async () => {
    await enableBatching({ batchPreferenceKm: 0.1 });
    const shop = await shopAt(SHOP);
    const busy = await riderAt(north(2));
    const first = await readyOrderTo(shop.id, north(3), 60);
    await acceptDeliveryOffer((await assignNearestPartner(first.id, admin)).id, busy.user.id);
    const idle = await riderAt(north(0.2));
    const second = await readyOrderTo(shop.id, north(3.2), 60);
    expect((await assignNearestPartner(second.id, admin)).deliveryPartnerId).toBe(idle.partner.id);
  });

  it("does not batch a drop in a different direction", async () => {
    await enableBatching();
    const { shop } = await riderWithOneOrder();
    const second = await readyOrderTo(shop.id, east(-3), 60); // west, the first goes north
    await expect(assignNearestPartner(second.id, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not batch a pickup too far from the trip's pickups", async () => {
    await enableBatching({ maxPickupDistanceKm: 0.5 });
    const { rider } = await riderWithOneOrder();
    const otherShop = await shopAt(north(1.5), "Far Dairy");
    const second = await readyOrderTo(otherShop.id, north(4), 60);
    const offer = await assignNearestPartner(second.id, admin).catch(() => null);
    expect(offer?.deliveryPartnerId).not.toBe(rider.partner.id);
  });

  it("does not batch when an order would miss its promised time", async () => {
    await enableBatching();
    const shop = await shopAt(SHOP);
    const rider = await riderAt(north(0.3));
    // Alone: ~1 min to the shop + 3 min stop + 9 min for 3 km = ~13 min, inside 17.
    const first = await readyOrderTo(shop.id, north(3), 17);
    await acceptDeliveryOffer((await assignNearestPartner(first.id, admin)).id, rider.user.id);
    // A nearer drop goes first: the first order arrives at ~19 min, after its promise — refused.
    const second = await readyOrderTo(shop.id, north(2), 60);
    await expect(assignNearestPartner(second.id, admin)).rejects.toMatchObject({ code: "CONFLICT" });
    // A drop beyond the first keeps it at ~16 min (one extra pickup stop): batched.
    const third = await readyOrderTo(shop.id, north(4), 60);
    expect((await assignNearestPartner(third.id, admin)).deliveryPartnerId).toBe(rider.partner.id);
  });

  it("does not add to a trip once something has been picked up", async () => {
    await enableBatching();
    const { shop, rider, firstDelivery } = await riderWithOneOrder();
    const [row] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, firstDelivery.id));
    await markPickedUp(firstDelivery.id, { id: rider.user.id, role: "DELIVERY_PARTNER" }, row.pickupCode ?? undefined);
    const second = await readyOrderTo(shop.id, north(3.2), 60);
    await expect(assignNearestPartner(second.id, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("stops at the maximum orders per trip", async () => {
    await enableBatching({ maxOrdersPerTrip: 2 });
    const { shop, rider } = await riderWithOneOrder();
    const second = await readyOrderTo(shop.id, north(3.2), 60);
    await acceptDeliveryOffer((await assignNearestPartner(second.id, admin)).id, rider.user.id);
    const third = await readyOrderTo(shop.id, north(3.4), 60);
    await expect(assignNearestPartner(third.id, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("the rider's stop list", () => {
  it("collects both orders first, then drops nearest-first, and the main card follows the list", async () => {
    await enableBatching();
    const { shop, rider, firstDelivery } = await riderWithOneOrder();
    const neighbour = await shopAt(north(0.2), "Bakery Next Door");
    const second = await readyOrderTo(neighbour.id, north(2), 60);
    const offer = await assignNearestPartner(second.id, admin);
    await acceptDeliveryOffer(offer.id, rider.user.id);

    const trip = await getRiderTrip(rider.user.id);
    expect(trip?.stops.map((s) => s.kind)).toEqual(["PICKUP", "PICKUP", "DROP", "DROP"]);
    // The nearer drop (2 km) comes before the 3 km one.
    expect(trip?.stops[2].deliveryOrderId).toBe(offer.id);
    expect(trip?.stops[0].current).toBe(true);

    // Main card: the first pickup in the list, then after it is collected, the next one.
    const main = await getMyActiveDeliveryOrder(rider.user.id);
    expect(main?.id).toBe(trip?.stops[0].deliveryOrderId);
    const [mainRow] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.id, main!.id));
    await markPickedUp(main!.id, { id: rider.user.id, role: "DELIVERY_PARTNER" }, mainRow.pickupCode ?? undefined);
    const nextMain = await getMyActiveDeliveryOrder(rider.user.id);
    expect(nextMain?.status).toBe("ACCEPTED"); // still a pickup to make before any drop
    expect([firstDelivery.id, offer.id]).toContain(nextMain?.id);

    // Each order keeps its own status.
    const statuses = await db.select({ id: deliveryOrders.id, s: deliveryOrders.status }).from(deliveryOrders);
    expect(new Set(statuses.map((r) => r.s))).toEqual(new Set(["PICKED_UP", "ACCEPTED"]));
    expect((await db.select().from(shops).where(eq(shops.id, shop.id))).length).toBe(1);
  });
});

describe("planner (pure)", () => {
  const member = (id: string, pickup = SHOP, drop = north(3), promisedInMin: number | null = 60, status = "ACCEPTED"): TripMember => ({
    deliveryOrderId: id,
    orderId: id,
    orderNumber: id,
    status,
    pickup,
    pickupLabel: "Shop",
    drop,
    dropLabel: "Drop",
    promisedByAt: promisedInMin == null ? null : new Date(Date.now() + promisedInMin * 60_000),
  });
  const rule = {
    enabled: true,
    maxOrdersPerTrip: 3,
    maxPickupDistanceKm: 0.5,
    maxDropBearingDegrees: 45,
    directionFreeWithinKm: 1,
    stopMinutes: 3,
    batchPreferenceKm: 1,
  };

  it("bearing and angle helpers", () => {
    expect(Math.round(bearingDegrees(SHOP, north(1)))).toBe(0);
    expect(Math.round(bearingDegrees(SHOP, east(1)))).toBe(90);
    expect(angleBetween(350, 10)).toBe(20);
  });

  it("estimates arrival at every drop and flags a late one", () => {
    const stops = planTrip([member("a", SHOP, north(10), 20)], { start: SHOP, now: new Date(), stopMinutes: 3 });
    // 10 km at 20 km/h = 30 min > 20 min promise.
    expect(stops.find((s) => s.kind === "DROP")?.late).toBe(true);
  });

  it("allows a drop very close to the pickup in any direction", () => {
    const ok = checkBatchCompatibility([member("a")], member("b", SHOP, east(-0.5)), rule, { start: SHOP, now: new Date() });
    expect(ok.ok).toBe(true);
  });
});
