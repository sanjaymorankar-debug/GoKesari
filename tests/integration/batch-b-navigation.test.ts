/**
 * batch-2026-10 WS-B — F4.2.2 in-app rider navigation: provider selection
 * (mock / OSRM with a stubbed fetch / fallback), the route endpoint and its
 * authorization (only the rider of the delivery), legs and privacy.
 */
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as navGet } from "@/app/api/delivery-orders/[id]/navigation/route";
import { decodePolyline, encodePolyline } from "@/lib/navigation/geometry";
import { db } from "@/server/db";
import { deliveryOrders, mapsApiCallLog, orders, platformSettings } from "@/server/db/schema";
import { getNavigationRoute, setNavigationFetchForTests } from "@/server/routing";
import { acceptDeliveryOffer, assignNearestPartner } from "@/server/services/delivery-assignment";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

const SHOP = { latitude: 18.5, longitude: 73.85 };
const CUSTOMER = { latitude: 18.51, longitude: 73.86 };
const RIDER = { latitude: 18.495, longitude: 73.845 };

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["riderNavigation"]));
  clearRuleCache();
  setNavigationFetchForTests(null);
});
afterEach(() => setNavigationFetchForTests(null));

async function enableNav(overrides: Record<string, unknown> = {}) {
  const admin = await createUser({ role: "ADMIN" });
  await setRule("riderNavigation", { enabled: true, ...overrides }, { id: admin.id, role: "ADMIN" });
}

function osrmStub() {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        code: "Ok",
        routes: [
          {
            geometry: encodePolyline([RIDER, SHOP]),
            distance: 900,
            duration: 180,
            legs: [
              {
                steps: [
                  { distance: 900, duration: 180, name: "Main Rd", maneuver: { type: "depart", location: [RIDER.longitude, RIDER.latitude] } },
                  { distance: 0, duration: 0, name: "", maneuver: { type: "arrive", location: [SHOP.longitude, SHOP.latitude] } },
                ],
              },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetcher, calls };
}

async function scene() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, SHOP);
  const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
  await createDeliveryPartner(riderUser.id, { isOnline: true, ...RIDER, operatingRadiusKm: 10 });
  const customer = await createUser();
  const order = await createOrder(customer.id, shop.id, { status: "READY" });
  await db
    .update(orders)
    .set({
      deliveryAddressSnapshot: {
        line1: "Flat 9",
        area: "Aundh",
        city: "Pune",
        pincode: "411007",
        latitude: String(CUSTOMER.latitude),
        longitude: String(CUSTOMER.longitude),
      },
    })
    .where(eq(orders.id, order.id));
  const offer = await assignNearestPartner(order.id, { id: owner.id, role: "SHOP_OWNER" });
  const delivery = await acceptDeliveryOffer(offer.id, riderUser.id);
  return { riderUser, delivery, order };
}

function signIn(u: { id: string; email: string; name: string | null }) {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: "DELIVERY_PARTNER", status: "ACTIVE" } };
}

describe("routing providers", () => {
  it("TC-B26-B-036 mock provider (default): a straight-line route, no network call", async () => {
    await enableNav();
    const { fetcher, calls } = osrmStub();
    setNavigationFetchForTests(fetcher);
    const r = await getNavigationRoute(RIDER, SHOP);
    expect(r.provider).toBe("mock");
    expect(calls).toHaveLength(0);
  });

  it("TC-B26-B-037 OSRM provider (stubbed fetch): route line + steps, cached, the call logged", async () => {
    await enableNav({ provider: "osrm", osrmBaseUrl: "https://osrm.test" });
    const { fetcher, calls } = osrmStub();
    setNavigationFetchForTests(fetcher);
    const r = await getNavigationRoute(RIDER, SHOP, { entityType: "delivery_order", entityId: "x" });
    expect(r).toMatchObject({ provider: "osrm", distanceMeters: 900, durationSeconds: 180 });
    expect(r.steps[0].instruction).toBe("Start on Main Rd");
    expect(calls[0]).toContain("https://osrm.test/route/v1/driving/73.845,18.495;73.85,18.5?overview=full&geometries=polyline&steps=true");
    await getNavigationRoute(RIDER, SHOP);
    expect(calls).toHaveLength(1);
    const logs = await db.select().from(mapsApiCallLog);
    expect(logs).toEqual([expect.objectContaining({ service: "ROUTES", purpose: "rider_navigation", success: true })]);
  });

  it("TC-B26-B-038 a failing provider falls back to the straight-line route (never throws)", async () => {
    await enableNav({ provider: "osrm", osrmBaseUrl: "https://osrm.test" });
    setNavigationFetchForTests((async () => new Response("down", { status: 503 })) as typeof fetch);
    const r = await getNavigationRoute(RIDER, SHOP);
    expect(r.provider).toBe("straight_line");
    expect(r.steps.at(-1)?.maneuver).toBe("arrive");
    const [log] = await db.select().from(mapsApiCallLog);
    expect(log).toMatchObject({ success: false, errorMessage: "OSRM HTTP 503" });
  });
});

describe("GET /api/delivery-orders/[id]/navigation", () => {
  it("TC-B26-B-039 flag off: 404 (feature hidden)", async () => {
    const { riderUser, delivery } = await scene();
    signIn(riderUser);
    const r = await call(navGet, `/api/delivery-orders/${delivery.id}/navigation`, { params: { id: delivery.id } });
    expect(r.status).toBe(404);
  });

  it("TC-B26-B-040 the rider of the delivery gets leg 1 (to the shop) with settings from the rules; another rider gets 403", async () => {
    await enableNav({ offRouteMeters: 75, rerouteCooldownSeconds: 30, voiceDefaultOn: false });
    const { riderUser, delivery } = await scene();
    signIn(riderUser);
    const r = await call(navGet, `/api/delivery-orders/${delivery.id}/navigation`, { params: { id: delivery.id } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      leg: "TO_SHOP",
      status: "ACCEPTED",
      origin: RIDER,
      destination: { latitude: SHOP.latitude, longitude: SHOP.longitude },
      settings: { offRouteMeters: 75, rerouteCooldownSeconds: 30, voiceDefaultOn: false, trackingPingSeconds: 5 },
      googleMapsUrl: `https://www.google.com/maps/dir/?api=1&destination=${SHOP.latitude},${SHOP.longitude}`,
      dropStarted: false,
    });
    // Before pickup the customer's location is not part of the answer.
    expect(JSON.stringify(r.body)).not.toContain(String(CUSTOMER.longitude));

    const other = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(other.id, { isOnline: true, ...RIDER });
    signIn(other);
    expect((await call(navGet, `/api/delivery-orders/${delivery.id}/navigation`, { params: { id: delivery.id } })).status).toBe(403);
    state.session = null;
    expect((await call(navGet, `/api/delivery-orders/${delivery.id}/navigation`, { params: { id: delivery.id } })).status).toBe(401);
  });

  it("TC-B26-B-041 after pickup: leg 2 to the customer; a re-route starts from the rider's current position", async () => {
    await enableNav();
    const { riderUser, delivery } = await scene();
    await db.update(deliveryOrders).set({ status: "PICKED_UP", pickedUpAt: new Date() }).where(eq(deliveryOrders.id, delivery.id));
    signIn(riderUser);
    const here = { latitude: 18.503, longitude: 73.852 };
    const r = await call(navGet, `/api/delivery-orders/${delivery.id}/navigation?lat=${here.latitude}&lng=${here.longitude}`, {
      params: { id: delivery.id },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ leg: "TO_CUSTOMER", origin: here, destination: { ...CUSTOMER, label: "Flat 9, Aundh, Pune" } });
    const line = decodePolyline(r.body.route.polyline);
    expect(line[0].latitude).toBeCloseTo(here.latitude, 4);
    expect(line.at(-1)!.latitude).toBeCloseTo(CUSTOMER.latitude, 4);
    // Only one of lat/lng is refused.
    const bad = await call(navGet, `/api/delivery-orders/${delivery.id}/navigation?lat=18.5`, { params: { id: delivery.id } });
    expect(bad.status).toBe(422);
  });
});
