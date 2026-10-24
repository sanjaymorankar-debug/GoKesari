/**
 * The shopper's detected position saved as the delivery location (owner
 * request, 24 Oct 2026: "user location is not detected"). Real PostgreSQL:
 * POST /api/location names a device position after the nearest shop or saved
 * address from GoKesari's own data — never a Google call — keeps a location
 * already chosen when the automatic detection asks with `ifUnset`, and still
 * overwrites it on an explicit "Use my current location".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
  jar: new Map<string, string>(),
  googleCalls: [] as string[],
}));

// tests/setup.ts sets a placeholder server key: any Google call is counted here and answered with nothing.
vi.stubGlobal("fetch", async (input: string | URL) => {
  const url = String(input);
  if (!url.startsWith("https://maps.googleapis.com/")) throw new Error(`unexpected fetch ${url}`);
  state.googleCalls.push(url);
  return new Response(JSON.stringify({ status: "ZERO_RESULTS", results: [] }), { status: 200 });
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
import { LOCATION_COOKIE, parseLocation } from "@/lib/location";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { addresses, shops } from "@/server/db/schema";
import { clearPlaceCache, describePosition } from "@/server/services/place-lookup";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

// Kharadi, Pune.
const ME = { latitude: 18.5515, longitude: 73.9348 };
const saved = () => parseLocation(state.jar.get(LOCATION_COOKIE));
const post = (body: Record<string, unknown>) => call(locationRoute, "/api/location", { method: "POST", body });

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  clearPlaceCache();
  state.session = null;
  state.jar.clear();
  state.googleCalls = [];
});

describe("saving the device's position", () => {
  it("is named after the nearest known place, with no PIN code guessed and no Google call", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    await createShop(owner.id, { name: "Kharadi Dairy", latitude: ME.latitude + 0.003, longitude: ME.longitude });
    await db.update(shops).set({ area: "Kharadi", pincode: "411014" });

    const res = await post({ latitude: ME.latitude, longitude: ME.longitude });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ saved: true, label: "Kharadi, Pune", source: "DEVICE", pincode: null });
    expect(saved()).toMatchObject({ label: "Kharadi, Pune", source: "DEVICE", pincode: null, latitude: 18.5515, longitude: 73.9348 });
    expect(state.googleCalls).toHaveLength(0);
  });

  it("nothing known within 2 km: 'Current location', still no Google call — and Nearby may ask Google later", async () => {
    const res = await post({ latitude: 19.9, longitude: 75.3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ saved: true, label: "Current location" });
    expect(state.googleCalls).toHaveLength(0);
    // The empty answer was not remembered: the Nearby screen's own lookup still asks Google.
    await describePosition(19.9, 75.3);
    expect(state.googleCalls).toHaveLength(1);
  });

  it("a searched address keeps its own label and PIN code, without a lookup", async () => {
    const res = await post({ latitude: ME.latitude, longitude: ME.longitude, label: "Eon IT Park, Kharadi, Pune 411014", pincode: "411014" });
    expect(res.body).toMatchObject({ saved: true, label: "Eon IT Park, Kharadi, Pune 411014", pincode: "411014" });
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
