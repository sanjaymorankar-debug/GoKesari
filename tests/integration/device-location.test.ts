/**
 * The shopper's detected position saved as the delivery location (owner
 * requests, 24 Oct 2026: "user location is not detected", then a textual
 * address for the coordinates — approximate is fine, no paid service). Real
 * PostgreSQL: POST /api/location labels a device position with its
 * approximate street address from OpenStreetMap (free; one request per spot,
 * at most one a second, shared with the Nearby screen; never Google), else
 * with the area and city of the nearest shop or saved address, else "Current
 * location"; keeps a location already chosen when the automatic detection
 * asks with `ifUnset`, and still overwrites it on an explicit "Use my
 * current location".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
  jar: new Map<string, string>(),
  /** What OpenStreetMap answers: a Nominatim body, or "fail" for a server error. */
  osm: null as unknown,
  osmCalls: [] as { url: string; at: number; userAgent: string | null }[],
  googleCalls: [] as string[],
  nominatimUrl: undefined as string | undefined,
}));

// Nothing leaves the test: OpenStreetMap is answered here, and Google must never be asked.
vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("https://maps.googleapis.com/")) {
    state.googleCalls.push(url);
    return new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 });
  }
  if (!url.includes("/reverse?")) throw new Error(`unexpected fetch ${url}`);
  state.osmCalls.push({ url, at: Date.now(), userAgent: new Headers(init?.headers).get("user-agent") });
  if (state.osm === "fail") return new Response("Service Unavailable", { status: 503 });
  return new Response(JSON.stringify(state.osm ?? { error: "Unable to geocode" }), { status: 200 });
});

vi.mock("@/lib/env", async (original) => {
  const actual = await original<typeof import("@/lib/env")>();
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), NOMINATIM_URL: state.nominatimUrl }) };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (state.jar.has(name) ? { name, value: state.jar.get(name)! } : undefined),
    set: (name: string, value: string) => void state.jar.set(name, value),
    delete: (name: string) => void state.jar.delete(name),
  }),
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as locationRoute } from "@/app/api/location/route";
import { GET as nearbyRoute } from "@/app/api/shops/nearby/route";
import { LOCATION_COOKIE, locationAreaName, parseLocation } from "@/lib/location";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { addresses, shops } from "@/server/db/schema";
import { clearPlaceCache, describePosition } from "@/server/services/place-lookup";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

// Kharadi, Pune.
const ME = { latitude: 18.551523, longitude: 73.934812 };
const saved = () => parseLocation(state.jar.get(LOCATION_COOKIE));
const post = (body: Record<string, unknown>) => call(locationRoute, "/api/location", { method: "POST", body });

/** Nominatim's reverse answer (format=jsonv2) for ME. */
const LANE_5 = {
  place_id: 1,
  licence: "Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright",
  display_name: "12, Lane 5, Kharadi, Pune City, Pune, Maharashtra, 411014, India",
  address: {
    house_number: "12",
    road: "Lane 5",
    suburb: "Kharadi",
    city: "Pune",
    county: "Pune City",
    state_district: "Pune",
    state: "Maharashtra",
    postcode: "411014",
    country: "India",
    country_code: "in",
  },
};
const LANE_5_LINE = "12 Lane 5, Kharadi, Pune 411014";

async function kharadiShop() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  await createShop(owner.id, { name: "Kharadi Dairy", latitude: ME.latitude + 0.003, longitude: ME.longitude });
  await db.update(shops).set({ area: "Kharadi", pincode: "411014" });
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  clearPlaceCache();
  state.session = null;
  state.jar.clear();
  state.osm = null;
  state.osmCalls = [];
  state.googleCalls = [];
  state.nominatimUrl = undefined;
});

describe("saving the device's position", () => {
  it("is labelled with the approximate street address from OpenStreetMap — free, never Google", async () => {
    state.osm = LANE_5;
    const res = await post(ME);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ saved: true, label: LANE_5_LINE, source: "DEVICE" });
    // Approximate: no PIN code is saved from it; discovery goes by distance.
    expect(saved()).toMatchObject({ label: LANE_5_LINE, pincode: null, area: "Kharadi", latitude: 18.5515, longitude: 73.9348 });
    expect(locationAreaName(saved()!)).toBe("Kharadi");
    expect(state.googleCalls).toHaveLength(0);
    expect(state.osmCalls).toHaveLength(1);
    const asked = new URL(state.osmCalls[0].url);
    expect(asked.origin).toBe("https://nominatim.openstreetmap.org");
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({ format: "jsonv2", lat: "18.5515", lon: "73.9348", addressdetails: "1" });
    // Nominatim's usage policy: the app is named, with a contact.
    expect(state.osmCalls[0].userAgent).toMatch(/^GoKesari\/.*support@gokesari\.com/);
  });

  it("one request per spot: the next visitor there and the Nearby screen are answered from memory", async () => {
    state.osm = LANE_5;
    await post(ME);
    state.jar.clear();
    expect((await post({ latitude: 18.55149, longitude: 73.93481 })).body.label).toBe(LANE_5_LINE);
    const nearby = await call(nearbyRoute, `/api/shops/nearby?lat=${ME.latitude}&lng=${ME.longitude}`);
    expect(nearby.body.origin).toMatchObject({ source: "DEVICE", address: LANE_5_LINE, place: { area: "Kharadi", city: "Pune", pincode: "411014" } });
    expect(state.osmCalls).toHaveLength(1);
  });

  it("never more than one request a second: a second spot waits its turn", async () => {
    state.osm = LANE_5;
    await Promise.all([post(ME), post({ latitude: 18.56, longitude: 73.94 })]);
    expect(state.osmCalls).toHaveLength(2);
    expect(Math.abs(state.osmCalls[1].at - state.osmCalls[0].at)).toBeGreaterThanOrEqual(1_000);
  });

  it("OpenStreetMap has nothing there: the nearest known place's area and city", async () => {
    await kharadiShop();
    const res = await post(ME);
    expect(res.body).toMatchObject({ saved: true, label: "Kharadi, Pune", source: "DEVICE", pincode: null });
    expect(saved()).toMatchObject({ area: "Kharadi" });
    expect(state.osmCalls).toHaveLength(1);
  });

  it("OpenStreetMap failing: the same fallback, and the next save asks again", async () => {
    await kharadiShop();
    state.osm = "fail";
    expect((await post(ME)).body).toMatchObject({ saved: true, label: "Kharadi, Pune", pincode: null });
    state.osm = LANE_5;
    expect((await post(ME)).body).toMatchObject({ label: LANE_5_LINE });
    expect(state.osmCalls).toHaveLength(2);
  });

  it("NOMINATIM_URL=off: no request; another Nominatim server when it points to one", async () => {
    await kharadiShop();
    state.nominatimUrl = "off";
    expect((await post(ME)).body).toMatchObject({ saved: true, label: "Kharadi, Pune" });
    expect(state.osmCalls).toHaveLength(0);

    state.nominatimUrl = "https://geo.example.org/nominatim/";
    state.osm = LANE_5;
    expect((await post(ME)).body).toMatchObject({ label: LANE_5_LINE });
    expect(state.osmCalls[0].url).toMatch(/^https:\/\/geo\.example\.org\/nominatim\/reverse\?/);
  });

  it("nothing known by anyone: 'Current location', and the empty answer is remembered", async () => {
    const res = await post({ latitude: 19.9, longitude: 75.3 });
    expect(res.body).toMatchObject({ saved: true, label: "Current location", pincode: null });
    expect(locationAreaName(saved()!)).toBeNull();
    expect(await describePosition(19.9, 75.3)).toBeNull();
    expect(state.osmCalls).toHaveLength(1);
  });

  it("a searched address keeps its own label and PIN code, without a lookup", async () => {
    const res = await post({ ...ME, label: "Eon IT Park, Kharadi, Pune 411014", pincode: "411014" });
    expect(res.body).toMatchObject({ saved: true, label: "Eon IT Park, Kharadi, Pune 411014", pincode: "411014" });
    expect(state.osmCalls).toHaveLength(0);
  });
});

describe("the automatic detection never overwrites a choice (ifUnset)", () => {
  it("keeps a location already chosen; an explicit 'Use my current location' replaces it", async () => {
    await post({ pincode: "411001" });
    expect(saved()).toMatchObject({ source: "PINCODE", pincode: "411001" });

    const auto = await post({ latitude: ME.latitude, longitude: ME.longitude, ifUnset: true });
    expect(auto.status).toBe(200);
    expect(auto.body).toMatchObject({ saved: false, source: "PINCODE", label: "PIN 411001" });
    expect(saved()).toMatchObject({ source: "PINCODE", pincode: "411001" });

    const explicit = await post({ latitude: ME.latitude, longitude: ME.longitude });
    expect(explicit.body).toMatchObject({ saved: true, source: "DEVICE" });
    expect(saved()).toMatchObject({ source: "DEVICE" });
  });

  it("keeps a signed-in customer's saved address; saves when they have none", async () => {
    const customer = await createUser();
    state.session = { user: { id: customer.id, email: customer.email, name: null, image: null, role: "CUSTOMER", status: "ACTIVE" } };

    const first = await post({ latitude: ME.latitude, longitude: ME.longitude, ifUnset: true });
    expect(first.body).toMatchObject({ saved: true, source: "DEVICE" });

    state.jar.clear();
    await db.insert(addresses).values({ userId: customer.id, line1: "9 Lane", area: "Viman Nagar", city: "Pune", pincode: "411014", isDefault: true, addressType: "HOME" });
    const second = await post({ latitude: ME.latitude, longitude: ME.longitude, ifUnset: true });
    expect(second.body).toMatchObject({ saved: false, source: "ADDRESS", pincode: "411014" });
    expect(state.jar.has(LOCATION_COOKIE)).toBe(false);
  });

  it("refuses a position outside the globe", async () => {
    const res = await post({ latitude: 91, longitude: 73.9, ifUnset: true });
    expect(res.status).toBe(422);
    expect(state.jar.has(LOCATION_COOKIE)).toBe(false);
  });
});
