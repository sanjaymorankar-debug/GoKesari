/**
 * The shopper's detected position saved as the delivery location (owner
 * requests, 24 Oct 2026: "user location is not detected", then "the exact
 * address whenever possible"). Real PostgreSQL: POST /api/location labels a
 * device position with its street address where Google reverse geocoding
 * knows it (one call per spot, shared with the Nearby screen), else with the
 * area and city of the nearest shop or saved address, else "Current
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
  /** What Google answers: a reverse-geocoding body, or "fail" for a server error. */
  google: null as unknown,
  googleCalls: [] as string[],
  keySet: true,
}));

// Google is answered here, never called.
vi.stubGlobal("fetch", async (input: string | URL) => {
  const url = String(input);
  if (!url.startsWith("https://maps.googleapis.com/")) throw new Error(`unexpected fetch ${url}`);
  state.googleCalls.push(url);
  if (state.google === "fail") return new Response(JSON.stringify({ status: "UNKNOWN_ERROR" }), { status: 500 });
  return new Response(JSON.stringify(state.google ?? { status: "ZERO_RESULTS", results: [] }), { status: 200 });
});

vi.mock("@/lib/env", async (original) => ({
  ...(await original<typeof import("@/lib/env")>()),
  isGeocodingConfigured: () => state.keySet,
}));

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

/** Google's reverse-geocoding answer for ME: a bare plus code first, then the building. */
const EON = {
  status: "OK",
  results: [
    {
      types: ["plus_code"],
      formatted_address: "HWX3+JW Pune, Maharashtra, India",
      address_components: [{ long_name: "HWX3+JW", types: ["plus_code"] }],
    },
    {
      types: ["premise"],
      formatted_address: "HWX3+JW, Eon Free Zone, Kharadi, Pune, Maharashtra 411014, India",
      address_components: [
        { long_name: "Eon Free Zone", types: ["premise"] },
        { long_name: "Kharadi", types: ["sublocality_level_1", "sublocality", "political"] },
        { long_name: "Pune", types: ["locality", "political"] },
        { long_name: "411014", types: ["postal_code"] },
      ],
      geometry: { location: { lat: 18.5515, lng: 73.9348 } },
    },
  ],
};

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
  state.google = null;
  state.googleCalls = [];
  state.keySet = true;
});

describe("saving the device's position", () => {
  it("is labelled with the street address Google knows, with its PIN code", async () => {
    state.google = EON;
    const res = await post(ME);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ saved: true, label: "Eon Free Zone, Kharadi, Pune, Maharashtra 411014", pincode: "411014", source: "DEVICE" });
    expect(saved()).toMatchObject({ label: "Eon Free Zone, Kharadi, Pune, Maharashtra 411014", pincode: "411014", area: "Kharadi", latitude: 18.5515, longitude: 73.9348 });
    // Headings still say "Shops near Kharadi", not the building.
    expect(locationAreaName(saved()!)).toBe("Kharadi");
    // Asked at the ~11 m the location keeps.
    expect(state.googleCalls).toHaveLength(1);
    expect(new URL(state.googleCalls[0]).searchParams.get("latlng")).toBe("18.5515,73.9348");
  });

  it("one call per spot: the next visitor there and the Nearby screen are answered from memory", async () => {
    state.google = EON;
    await post(ME);
    state.jar.clear();
    expect((await post({ latitude: 18.55149, longitude: 73.93481 })).body.label).toBe("Eon Free Zone, Kharadi, Pune, Maharashtra 411014");
    const nearby = await call(nearbyRoute, `/api/shops/nearby?lat=${ME.latitude}&lng=${ME.longitude}`);
    expect(nearby.body.origin).toMatchObject({ source: "DEVICE", address: "Eon Free Zone, Kharadi, Pune, Maharashtra 411014", place: { area: "Kharadi", city: "Pune", pincode: "411014" } });
    expect(state.googleCalls).toHaveLength(1);
  });

  it("Google has nothing there: the nearest known place's area and city, with no PIN code guessed", async () => {
    await kharadiShop();
    const res = await post(ME);
    expect(res.body).toMatchObject({ saved: true, label: "Kharadi, Pune", source: "DEVICE", pincode: null });
    expect(saved()).toMatchObject({ area: "Kharadi" });
    expect(state.googleCalls).toHaveLength(1);
  });

  it("Google failing: the same fallback, and the next save asks again", async () => {
    await kharadiShop();
    state.google = "fail";
    expect((await post(ME)).body).toMatchObject({ saved: true, label: "Kharadi, Pune", pincode: null });
    state.google = EON;
    expect((await post(ME)).body).toMatchObject({ label: "Eon Free Zone, Kharadi, Pune, Maharashtra 411014" });
    expect(state.googleCalls).toHaveLength(2);
  });

  it("without the server key: no call, the nearest known place's area and city", async () => {
    await kharadiShop();
    state.keySet = false;
    expect((await post(ME)).body).toMatchObject({ saved: true, label: "Kharadi, Pune", pincode: null });
    expect(state.googleCalls).toHaveLength(0);
  });

  it("nothing known by anyone: 'Current location', and the empty answer is remembered", async () => {
    const res = await post({ latitude: 19.9, longitude: 75.3 });
    expect(res.body).toMatchObject({ saved: true, label: "Current location", pincode: null });
    expect(locationAreaName(saved()!)).toBeNull();
    expect(await describePosition(19.9, 75.3)).toBeNull();
    expect(state.googleCalls).toHaveLength(1);
  });

  it("a searched address keeps its own label and PIN code, without a lookup", async () => {
    const res = await post({ ...ME, label: "Eon IT Park, Kharadi, Pune 411014", pincode: "411014" });
    expect(res.body).toMatchObject({ saved: true, label: "Eon IT Park, Kharadi, Pune 411014", pincode: "411014" });
    expect(state.googleCalls).toHaveLength(0);
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
