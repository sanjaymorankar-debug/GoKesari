/**
 * docs/guest-cart-2026-11: the guest-cart routes as the HTTP layer runs them —
 * the preview is open to guests only while guest_cart_enabled is on, and the
 * merge always needs a session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";
import { POST as merge } from "@/app/api/cart/merge/route";
import { POST as preview } from "@/app/api/cart/preview/route";
import { db } from "@/server/db";
import { carts } from "@/server/db/schema";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";
import { call } from "../helpers/http";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

let shopProductId: string;
let admin: { id: string; role: UserRole };

beforeEach(async () => {
  await resetDatabase();
  clearFeatureFlagCache();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id, { name: "Dairy One" });
  shopProductId = (await createShopProduct(shop.id, milk.id, { onlinePricePaise: 7000, onlineStock: 50 })).id;
});
afterEach(() => {
  state.session = null;
});

const flagOn = () => setFeatureFlag("guest_cart_enabled", { enabled: true, districtCodes: null }, "guest cart test", admin);

describe("POST /api/cart/preview", () => {
  it("answers 404 while the flag is off (the site as before)", async () => {
    const res = await call(preview, "/api/cart/preview", { method: "POST", body: { lines: [{ shopProductId, quantity: 1 }] } });
    expect(res.status).toBe(404);
  });

  it("prices a guest's lines when on, without a session and without saving a cart", async () => {
    await flagOn();
    const res = await call(preview, "/api/cart/preview", { method: "POST", body: { lines: [{ shopProductId, quantity: 2 }] } });
    expect(res.status).toBe(200);
    expect(res.body.grandTotalPaise).toBeGreaterThanOrEqual(14000);
    expect(res.body.groups[0].lines[0].shopProductId).toBe(shopProductId);
    expect(await db.select().from(carts)).toHaveLength(0);
  });

  it("refuses more than 50 lines", async () => {
    await flagOn();
    const lines = Array.from({ length: 51 }, (_, i) => ({ shopProductId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, quantity: 1 }));
    expect((await call(preview, "/api/cart/preview", { method: "POST", body: { lines } })).status).toBe(422);
  });
});

describe("POST /api/cart/merge", () => {
  it("refuses a guest with 401, flag on or off", async () => {
    const body = { lines: [{ shopProductId, quantity: 1 }] };
    expect((await call(merge, "/api/cart/merge", { method: "POST", body })).status).toBe(401);
    await flagOn();
    expect((await call(merge, "/api/cart/merge", { method: "POST", body })).status).toBe(401);
  });

  it("moves the lines into the signed-in customer's cart", async () => {
    await flagOn();
    const u = await createUser();
    state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
    const res = await call(merge, "/api/cart/merge", { method: "POST", body: { lines: [{ shopProductId, quantity: 3 }] } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ added: 1, reduced: [], dropped: [] });
  });
});
