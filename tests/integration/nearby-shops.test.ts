/**
 * Nearby shops from a real position (docs/nearby-referral-2026-10, feature 1).
 * Real PostgreSQL: the Haversine distance is worked out in SQL, so it is
 * checked here against the same formula in JavaScript and against known
 * distances; the radius filter, nearest-first order, which shops count
 * (approved, live, with a usable location), the PIN code / area fallback,
 * the place label, the directions link and the admin report of shops
 * without a location.
 */
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
  /** Google geocoding answers, by a substring of the request URL; anything else is ZERO_RESULTS. */
  google: [] as { match: string; body: unknown }[],
  googleCalls: [] as string[],
}));

// tests/setup.ts sets a placeholder server key: Google is answered here, never called.
vi.stubGlobal("fetch", async (input: string | URL) => {
  const url = String(input);
  if (!url.startsWith("https://maps.googleapis.com/")) throw new Error(`unexpected fetch ${url}`);
  state.googleCalls.push(url);
  const hit = state.google.find((g) => url.includes(g.match));
  return new Response(JSON.stringify(hit?.body ?? { status: "ZERO_RESULTS", results: [] }), { status: 200 });
});

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as nearbyRoute } from "@/app/api/shops/nearby/route";
import { GET as reportRoute, POST as backfillRoute } from "@/app/api/admin/shops/missing-location/route";
import { directionsUrl, formatDistance, parseNearbyRadius, placeLine, widerRadius } from "@/lib/geo/nearby";
import { haversineDistanceKm } from "@/lib/geo/haversine";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { addresses, shops } from "@/server/db/schema";
import { findNearbyShops, shopsMissingLocation } from "@/server/services/nearby-shops";
import { clearPlaceCache, describePosition, findPlace } from "@/server/services/place-lookup";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

// Kharadi, Pune (the user), and points at measured offsets from it.
const ME = { latitude: 18.5515, longitude: 73.9348 };
/** A point `km` north (positive) or south of ME — 1° of latitude is 111.195 km on the 6371 km sphere. */
const north = (km: number) => ({ latitude: ME.latitude + km / 111.19493, longitude: ME.longitude });

let ownerId = "";

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  clearPlaceCache();
  state.session = null;
  state.google = [];
  state.googleCalls = [];
  ownerId = (await createUser({ role: "SHOP_OWNER" })).id;
});

async function shopAt(name: string, at: { latitude: number; longitude: number } | null, extra: Parameters<typeof createShop>[1] = {}) {
  return createShop(ownerId, { name, latitude: at?.latitude ?? null, longitude: at?.longitude ?? null, ...extra });
}

const nearby = (query: string) => call(nearbyRoute, `/api/shops/nearby?${query}`);

describe("distance text and links", () => {
  it("metres below 1 km, km to one decimal from 1 km", () => {
    expect(formatDistance(0.004)).toBe("10 m");
    expect(formatDistance(0.3504)).toBe("350 m");
    expect(formatDistance(0.994)).toBe("990 m");
    expect(formatDistance(0.996)).toBe("1.0 km");
    expect(formatDistance(1)).toBe("1.0 km");
    expect(formatDistance(4.26)).toBe("4.3 km");
    expect(formatDistance(9.95)).toBe("10.0 km");
  });

  it("radius choices, widening and the place line", () => {
    expect(parseNearbyRadius("3")).toBe(3);
    expect(parseNearbyRadius("7")).toBe(5);
    expect(parseNearbyRadius(undefined)).toBe(5);
    expect(widerRadius(1)).toBe(3);
    expect(widerRadius(10)).toBeNull();
    expect(placeLine({ area: "Kharadi", city: "Pune", pincode: "411014" })).toBe("Kharadi, Pune 411014");
    expect(placeLine({ area: "Pune", city: "pune", pincode: null })).toBe("Pune");
  });

  it("directions go from the user's position to the shop in Google Maps", () => {
    expect(directionsUrl(ME, { latitude: 18.5603, longitude: 73.9221 })).toBe(
      "https://www.google.com/maps/dir/?api=1&origin=18.5515%2C73.9348&destination=18.5603%2C73.9221",
    );
  });
});

describe("nearby shops", () => {
  it("lists approved shops within the radius, nearest first, with server-side Haversine distances", async () => {
    await shopAt("Far 4.2", north(4.2));
    await shopAt("Near 0.35", north(0.35));
    await shopAt("Mid 2.5", north(-2.5));
    await shopAt("Edge 9.8", north(9.8));
    await shopAt("Beyond 12", north(12));
    const sevenEast = { latitude: ME.latitude, longitude: ME.longitude + 0.0665 }; // ~7.0 km east
    await shopAt("East 7", sevenEast);

    const res = await nearby(`lat=${ME.latitude}&lng=${ME.longitude}&radiusKm=5`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.shops.map((s: { name: string }) => s.name)).toEqual(["Near 0.35", "Mid 2.5", "Far 4.2"]);
    expect(res.body.countsByRadius).toEqual({ 1: 1, 3: 2, 5: 3, 10: 5 });
    const [first, second, third] = res.body.shops;
    expect(first.distanceText).toBe("350 m");
    expect(second.distanceText).toBe("2.5 km");
    expect(third.distanceText).toBe("4.2 km");
    // The SQL formula agrees with the JavaScript one to the metre.
    for (const shop of res.body.shops) {
      expect(Math.abs(shop.distanceKm - haversineDistanceKm(ME, shop))).toBeLessThan(0.001);
    }
    expect(first.directionsUrl).toContain(`origin=${ME.latitude}%2C${ME.longitude}`);
    expect(res.body.origin).toMatchObject({ ...ME, source: "DEVICE" });

    // Each radius.
    for (const [km, names] of [
      [1, ["Near 0.35"]],
      [3, ["Near 0.35", "Mid 2.5"]],
      [10, ["Near 0.35", "Mid 2.5", "Far 4.2", "East 7", "Edge 9.8"]],
    ] as const) {
      const r = await nearby(`lat=${ME.latitude}&lng=${ME.longitude}&radiusKm=${km}`);
      expect(r.body.radiusKm).toBe(km);
      expect(r.body.shops.map((s: { name: string }) => s.name)).toEqual(names);
    }
  });

  it("matches known real-world distances (Haversine on a 6371 km sphere)", async () => {
    // Pune Railway Station → Shaniwar Wada ≈ 2.47 km; → Phoenix Marketcity Viman Nagar ≈ 6.1 km straight line.
    const station = { latitude: 18.5289, longitude: 73.8744 };
    await shopAt("Shaniwar Wada", { latitude: 18.5195, longitude: 73.8553 });
    await shopAt("Phoenix Marketcity", { latitude: 18.5622, longitude: 73.9167 });
    const result = await findNearbyShops(station, 10);
    const byName = Object.fromEntries(result.shops.map((s) => [s.name, s.distanceKm]));
    expect(byName["Shaniwar Wada"]).toBeCloseTo(haversineDistanceKm(station, { latitude: 18.5195, longitude: 73.8553 }), 3);
    expect(byName["Shaniwar Wada"]).toBeGreaterThan(2.2);
    expect(byName["Shaniwar Wada"]).toBeLessThan(2.4);
    expect(byName["Phoenix Marketcity"]).toBeGreaterThan(5.6);
    expect(byName["Phoenix Marketcity"]).toBeLessThan(5.9);
  });

  it("leaves out shops that are not approved and live, and shops without a usable location", async () => {
    await shopAt("Live", north(1));
    await shopAt("Pending", north(1), { status: "PENDING_APPROVAL" });
    await shopAt("Rejected", north(1), { status: "REJECTED" });
    await shopAt("Suspended", north(1), { status: "SUSPENDED" });
    const deleted = await shopAt("Deleted", north(1));
    await db.update(shops).set({ deletedAt: new Date() }).where(eq(shops.id, deleted.id));
    await shopAt("No location", null);
    const bad = await shopAt("Bad location", null);
    await db.update(shops).set({ latitude: "18.55abc", longitude: "73.93" }).where(eq(shops.id, bad.id));
    const zero = await shopAt("Zero location", null);
    await db.update(shops).set({ latitude: "0", longitude: "0" }).where(eq(shops.id, zero.id));

    const res = await nearby(`lat=${ME.latitude}&lng=${ME.longitude}&radiusKm=10`);
    expect(res.status).toBe(200); // a malformed value never breaks the query
    expect(res.body.shops.map((s: { name: string }) => s.name)).toEqual(["Live"]);

    // …and the ones without a location are listed for operations (approved first, then pending).
    await shopAt("Pending no location", null, { status: "PENDING_APPROVAL" });
    const missing = await shopsMissingLocation();
    expect(missing.map((m) => [m.name, m.problem])).toEqual([
      ["Bad location", "INVALID"],
      ["No location", "MISSING"],
      ["Zero location", "INVALID"],
      ["Pending no location", "MISSING"],
    ]);
  });

  it("shows open / closed and whether the shop takes orders", async () => {
    const closedAllWeek = Array.from({ length: 7 }, (_, day) => ({ day, open: "06:00", close: "22:00", closed: true }));
    const closed = await shopAt("Closed shop", north(0.5));
    await db.update(shops).set({ openingHours: closedAllWeek }).where(eq(shops.id, closed.id));
    const paused = await shopAt("Paused shop", north(0.6));
    await db.update(shops).set({ ordersPaused: true }).where(eq(shops.id, paused.id));
    await shopAt("Open shop", north(0.7));
    const res = await findNearbyShops(ME, 1);
    const byName = Object.fromEntries(res.shops.map((s) => [s.name, s]));
    expect(byName["Closed shop"]).toMatchObject({ open: false, takingOrders: true, shopTypeLabel: expect.any(String) });
    expect(byName["Paused shop"]).toMatchObject({ open: true, takingOrders: false });
    expect(byName["Open shop"]).toMatchObject({ open: true, takingOrders: true });
  });

  it("no shop in range: an empty list with the counts to widen", async () => {
    await shopAt("Far", north(8));
    const res = await nearby(`lat=${ME.latitude}&lng=${ME.longitude}&radiusKm=3`);
    expect(res.body.shops).toEqual([]);
    expect(res.body.countsByRadius).toEqual({ 1: 0, 3: 0, 5: 0, 10: 1 });
  });

  it("refuses a request without a position or place, and a radius that is not offered falls back to 5 km", async () => {
    expect((await nearby("radiusKm=5")).status).toBe(422);
    expect((await nearby(`lat=${ME.latitude}&lng=${ME.longitude}&radiusKm=50`)).body.radiusKm).toBe(5);
  });
});

describe("location refused: search from a PIN code or area", () => {
  it("searches from the centre of the shops and addresses in that PIN code", async () => {
    await shopAt("Kharadi Dairy", north(0.2), {});
    await db.update(shops).set({ pincode: "411014", area: "Kharadi" });
    const user = await createUser();
    await db.insert(addresses).values({
      userId: user.id,
      fullName: "A",
      phone: "9876543210",
      line1: "1 Road",
      area: "Kharadi",
      city: "Pune",
      pincode: "411014",
      latitude: String(north(-0.2).latitude),
      longitude: String(ME.longitude),
    } as typeof addresses.$inferInsert);

    const res = await nearby("q=411014&radiusKm=1");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.origin).toMatchObject({ source: "PLACE", place: { pincode: "411014", area: "Kharadi", city: "Pune" } });
    expect(res.body.origin.latitude).toBeCloseTo(ME.latitude, 3);
    expect(res.body.shops.map((s: { name: string }) => s.name)).toEqual(["Kharadi Dairy"]);
    expect(res.body.shops[0].distanceText).toBe("200 m");

    // An area name works the same way.
    const byArea = await findPlace("kharadi");
    expect(byArea).toMatchObject({ area: "Kharadi", pincode: "411014", source: "GOKESARI" });
  });

  it("a PIN code GoKesari has no data for is asked of Google; one nobody knows is a clear 404", async () => {
    await shopAt("Baner Bakery", { latitude: 18.559, longitude: 73.7868 });
    state.google.push({
      match: "postal_code%3A411045",
      body: {
        status: "OK",
        results: [
          {
            geometry: { location: { lat: 18.5596, lng: 73.7799 } },
            address_components: [
              { long_name: "Baner", types: ["sublocality_level_1", "sublocality"] },
              { long_name: "Pune", types: ["locality"] },
              { long_name: "411045", types: ["postal_code"] },
            ],
          },
        ],
      },
    });
    const found = await nearby("q=411045&radiusKm=1");
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.origin).toMatchObject({ source: "PLACE", place: { area: "Baner", city: "Pune", pincode: "411045" } });
    expect(found.body.shops.map((s: { name: string }) => s.name)).toEqual(["Baner Bakery"]);
    // Asked once; the second search is answered from memory.
    await nearby("q=411045&radiusKm=3");
    expect(state.googleCalls).toHaveLength(1);

    const res = await nearby("q=999999&radiusKm=5");
    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain("couldn't find that PIN code or area");
  });

  it("the detected position is named after the nearest known place", async () => {
    await shopAt("Somewhere", north(0.3));
    await db.update(shops).set({ pincode: "411014", area: "Kharadi" });
    expect(await describePosition(ME.latitude, ME.longitude)).toEqual({ area: "Kharadi", city: "Pune", pincode: "411014" });
    expect(await describePosition(19.9, 75.3)).toBeNull(); // nothing known within 2 km, and Google has nothing either
    expect(state.googleCalls).toHaveLength(1); // only for the unknown spot
    const res = await nearby(`lat=${ME.latitude}&lng=${ME.longitude}`);
    expect(res.body.origin.place).toEqual({ area: "Kharadi", city: "Pune", pincode: "411014" });
  });
});

describe("admin report of shops without a location", () => {
  it("operations and admin see it (and the CSV); customers and shop owners do not", async () => {
    await shopAt("No pin", null);
    for (const role of ["CUSTOMER", "SHOP_OWNER"] as const) {
      const u = await createUser({ role });
      state.session = { user: { id: u.id, email: u.email, name: null, image: null, role, status: "ACTIVE" } };
      expect((await call(reportRoute, "/api/admin/shops/missing-location")).status).toBe(403);
    }
    const op = await createUser({ role: "OPERATOR" });
    state.session = { user: { id: op.id, email: op.email, name: null, image: null, role: "OPERATOR", status: "ACTIVE" } };
    const res = await call(reportRoute, "/api/admin/shops/missing-location");
    expect(res.status).toBe(200);
    expect(res.body.shops.map((s: { name: string }) => s.name)).toEqual(["No pin"]);
    expect(res.body.geocoding).toBe(true);
    const csv = await reportRoute(new NextRequest("http://localhost/api/admin/shops/missing-location?format=csv"));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain('"No pin"');
    // Operators can edit any shop, so they can fill from the address too (Google has no answer here).
    const fill = await call(backfillRoute, "/api/admin/shops/missing-location", { method: "POST", body: {} });
    expect(fill.status).toBe(200);
    expect(fill.body.results).toMatchObject([{ name: "No pin", result: "NOT_FOUND" }]);
    const owner = await createUser({ role: "SHOP_OWNER" });
    state.session = { user: { id: owner.id, email: owner.email, name: null, image: null, role: "SHOP_OWNER", status: "ACTIVE" } };
    expect((await call(backfillRoute, "/api/admin/shops/missing-location", { method: "POST", body: {} })).status).toBe(403);
  });

  it("fills a location from the address — only when Google places it in the shop's own PIN code", async () => {
    const good = await shopAt("Good address", null);
    const wrong = await shopAt("Wrong PIN", null);
    await db.update(shops).set({ addressLine1: "Elsewhere Road" }).where(eq(shops.id, wrong.id));
    const result = (lat: number, lng: number, pin: string) => ({
      status: "OK",
      results: [{ geometry: { location: { lat, lng } }, address_components: [{ long_name: pin, types: ["postal_code"] }] }],
    });
    state.google.push({ match: "1+Test+Road", body: result(18.5204, 73.8567, "411001") });
    state.google.push({ match: "Elsewhere+Road", body: result(19.07, 72.87, "400001") });
    const admin = await createUser({ role: "ADMIN" });
    state.session = { user: { id: admin.id, email: admin.email, name: null, image: null, role: "ADMIN", status: "ACTIVE" } };
    const fill = await call(backfillRoute, "/api/admin/shops/missing-location", { method: "POST", body: {} });
    expect(fill.status, JSON.stringify(fill.body)).toBe(200);
    const outcome = Object.fromEntries(fill.body.results.map((r: { name: string; result: string }) => [r.name, r.result]));
    expect(outcome).toEqual({ "Good address": "FILLED", "Wrong PIN": "NOT_FOUND" });
    const [saved] = await db.select().from(shops).where(eq(shops.id, good.id));
    expect(saved).toMatchObject({ latitude: "18.520400", longitude: "73.856700", locationSource: "MANUAL_ENTRY", locationVerified: false });
    const [untouched] = await db.select().from(shops).where(eq(shops.id, wrong.id));
    expect(untouched.latitude).toBeNull();
    expect((await shopsMissingLocation()).map((s) => s.name)).toEqual(["Wrong PIN"]);
  });
});
