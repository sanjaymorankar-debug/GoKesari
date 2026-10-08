/**
 * F4 — road routing and arrival-time estimates. getRoute() uses the configured
 * provider and falls back to the original straight-line estimate whenever
 * routing is off or the call fails, so callers never see an error.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildOrderTracking } from "@/lib/tracking";
import { db } from "@/server/db";
import { deliveryOrders, mapsApiCallLog, orders, platformSettings } from "@/server/db/schema";
import { assignNearestPartner } from "@/server/services/delivery-assignment";
import { getRoute, setRoutingFetchForTests, straightLineRoute } from "@/server/services/routing";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createDeliveryPartner, createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

const A = { latitude: 18.5204, longitude: 73.8567 };
const B = { latitude: 18.5304, longitude: 73.8667 };

async function enableRouting(provider: "osrm" | "google" = "osrm", timeoutMs = 3000) {
  const admin = await createUser({ role: "ADMIN" });
  await setRule(
    "routing",
    { enabled: true, provider, osrmBaseUrl: "https://osrm.test", timeoutMs, cacheSeconds: 60 },
    { id: admin.id, role: "ADMIN" },
  );
}

function osrmReply(distanceM: number, durationS: number) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: distanceM, duration: durationS }] }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "routing"));
  clearRuleCache();
  setRoutingFetchForTests(null);
});
afterEach(() => setRoutingFetchForTests(null));

describe("getRoute", () => {
  it("is exactly the original straight-line estimate when routing is off (default)", async () => {
    const { fetcher, calls } = osrmReply(5000, 600);
    setRoutingFetchForTests(fetcher);
    expect(await getRoute(A, B, { purpose: "test" })).toEqual(straightLineRoute(A, B));
    expect(calls).toHaveLength(0);
  });

  it("uses road distance and time from OSRM, caches it and logs the call", async () => {
    await enableRouting("osrm");
    const { fetcher, calls } = osrmReply(2400, 420);
    setRoutingFetchForTests(fetcher);
    const r = await getRoute(A, B, { purpose: "test", entityType: "order", entityId: "x" });
    expect(r).toEqual({ distanceKm: 2.4, durationSeconds: 420, source: "ROAD" });
    expect(calls[0]).toContain("https://osrm.test/route/v1/driving/73.8567,18.5204;73.8667,18.5304");
    await getRoute(A, B, { purpose: "test" });
    expect(calls).toHaveLength(1);
    const log = await db.select().from(mapsApiCallLog).where(eq(mapsApiCallLog.service, "ROUTES"));
    expect(log).toHaveLength(1);
    expect(log[0].success).toBe(true);
  });

  it("falls back to straight-line when the provider errors or times out", async () => {
    await enableRouting("osrm", 500);
    setRoutingFetchForTests((async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch);
    expect(await getRoute(A, B, { purpose: "test" })).toEqual(straightLineRoute(A, B));

    setRoutingFetchForTests((async () => new Response("down", { status: 503 })) as typeof fetch);
    expect(await getRoute(A, B, { purpose: "test" })).toEqual(straightLineRoute(A, B));

    const log = await db.select().from(mapsApiCallLog).where(eq(mapsApiCallLog.service, "ROUTES"));
    expect(log.map((l) => l.success)).toEqual([false, false]);
    expect(log.some((l) => l.errorMessage?.includes("Timed out"))).toBe(true);
  });
});

describe("delivery assignment", () => {
  it("records the road leg on the delivery when routing is on", async () => {
    await enableRouting("osrm");
    setRoutingFetchForTests(osrmReply(3100, 540).fetcher);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { latitude: A.latitude, longitude: A.longitude });
    const riderUser = await createUser({ role: "DELIVERY_PARTNER" });
    await createDeliveryPartner(riderUser.id, { isOnline: true, latitude: A.latitude + 0.005, longitude: A.longitude });
    const customer = await createUser();
    const order = await createOrder(customer.id, shop.id, { status: "READY" });
    await db
      .update(orders)
      .set({ deliveryAddressSnapshot: { line1: "1 MG Road", city: "Pune", state: "MH", pincode: "411001", latitude: String(B.latitude), longitude: String(B.longitude) } as never })
      .where(eq(orders.id, order.id));
    const admin = await createUser({ role: "ADMIN" });
    await assignNearestPartner(order.id, { id: admin.id, role: "ADMIN" });
    const [d] = await db.select().from(deliveryOrders).where(eq(deliveryOrders.orderId, order.id));
    expect(d.routeSource).toBe("ROAD");
    expect(d.legDurationSeconds).toBe(540);
    expect(d.pickupDurationSeconds).toBe(540);
  });
});

describe("buildOrderTracking", () => {
  // A drop under way: the rider's location (and so the ETA) is shared only
  // once the drop has started (event layer; see tests/unit/tracking.test.ts).
  const base = {
    orderId: "o1",
    orderStatus: "OUT_FOR_DELIVERY" as const,
    shopDispatchesRiders: false,
    delivery: {
      status: "PICKED_UP" as const,
      pickedUpAt: new Date(Date.now() - 120_000),
      startedAt: new Date(Date.now() - 60_000),
    },
    riderFix: { ...A, recordedAt: new Date() },
    destination: B,
    now: new Date(),
  };

  it("uses the road estimate and gives an arrival time", () => {
    const t = buildOrderTracking({ ...base, route: { distanceKm: 2.43, durationSeconds: 400, source: "ROAD" } });
    expect(t.etaMinutes).toBe(7);
    expect(t.distanceToDestinationKm).toBe(2.4);
    expect(t.etaSource).toBe("ROAD");
    expect(new Date(t.estimatedArrivalAt!).getTime()).toBe(base.now.getTime() + 7 * 60_000);
  });

  it("keeps the straight-line numbers without a route", () => {
    const t = buildOrderTracking(base);
    expect(t.etaSource).toBe("STRAIGHT_LINE");
    expect(t.etaMinutes).toBeGreaterThan(0);
  });
});
