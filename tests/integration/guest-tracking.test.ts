/**
 * docs/guest-checkout-2026-11: tracking without sign-in against real SQL — a group's link shows that
 * group's orders only (never another group's or another customer's), the /track lookup by reference
 * + mobile digits, and the e-mailed link only for guest-created accounts with the flags on.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Guest calls: no session.
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import type { UserRole } from "@/server/db/schema";
import { db } from "@/server/db";
import { orderGroups, orders, users } from "@/server/db/schema";
import { verifyTrackingToken } from "@/server/guest-checkout/token";
import { getTrackingView, guestTrackingLinkFor, LOOKUP_FAILED, lookupByMobileDigits } from "@/server/guest-checkout/tracking";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: UserRole };

async function group(userId: string, reference: string) {
  const [g] = await db.insert(orderGroups).values({ userId, requestId: `req-${reference}`, reference }).returning();
  return g;
}

beforeEach(async () => {
  await resetDatabase();
  clearFeatureFlagCache();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

const flagsOn = async () => {
  await setFeatureFlag("guest_cart_enabled", { enabled: true, districtCodes: null }, "guest checkout test", admin);
  await setFeatureFlag("guest_checkout_enabled", { enabled: true, districtCodes: null }, "guest checkout test", admin);
};

describe("getTrackingView", () => {
  it("shows the group's own shop orders only, with first name and a masked mobile", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shopA = await createShop(owner.id, { name: "Dairy One" });
    const shopB = await createShop(owner.id, { name: "Kirana Two" });
    const customer = await createUser({ name: "Asha Kulkarni", mobile: "9876543210" });
    const other = await createUser({ name: "Ravi" });
    const mine = await group(customer.id, "GK-20261123-AAAAAA");
    const theirs = await group(other.id, "GK-20261123-BBBBBB");
    const o1 = await createOrder(customer.id, shopA.id, { status: "CONFIRMED" });
    const o2 = await createOrder(customer.id, shopB.id, { status: "PREPARING" });
    const o3 = await createOrder(other.id, shopA.id);
    const stray = await createOrder(other.id, shopB.id);
    await db.update(orders).set({ orderGroupId: mine.id }).where(eq(orders.id, o1.id));
    await db.update(orders).set({ orderGroupId: mine.id }).where(eq(orders.id, o2.id));
    await db.update(orders).set({ orderGroupId: theirs.id }).where(eq(orders.id, o3.id));
    // A row pointing at my group but owned by someone else must never show.
    await db.update(orders).set({ orderGroupId: mine.id }).where(eq(orders.id, stray.id));

    const view = await getTrackingView({ kind: "G", id: mine.id });
    expect(view?.reference).toBe("GK-20261123-AAAAAA");
    expect(view?.orders.map((o) => o.id).sort()).toEqual([o1.id, o2.id].sort());
    expect(view?.customer).toEqual({ firstName: "Asha", maskedPhone: expect.stringMatching(/3210$/) });
    expect(JSON.stringify(view)).not.toContain(customer.email);
    expect(view?.timeline.overall.stage).toBe("ACCEPTED");

    const single = await getTrackingView({ kind: "O", id: o3.id });
    expect(single?.orders.map((o) => o.id)).toEqual([o3.id]);
    expect(await getTrackingView({ kind: "G", id: "00000000-0000-4000-8000-000000000000" })).toBeNull();
  });
});

describe("lookupByMobileDigits", () => {
  it("opens the group with the right last 4 digits, refuses wrong digits and unknown references alike", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Dairy One" });
    const customer = await createUser({ mobile: "9876543210" });
    const g = await group(customer.id, "GK-20261123-CCCCCC");
    const o = await createOrder(customer.id, shop.id);
    await db.update(orders).set({ orderGroupId: g.id }).where(eq(orders.id, o.id));

    const ok = await lookupByMobileDigits({ reference: "gk-20261123-cccccc", last4: "3210" });
    const check = verifyTrackingToken(ok.url.replace("/track/", ""));
    expect(check).toMatchObject({ ok: true, target: { kind: "G", id: g.id } });

    await expect(lookupByMobileDigits({ reference: "GK-20261123-CCCCCC", last4: "0000" })).rejects.toThrow(LOOKUP_FAILED);
    await expect(lookupByMobileDigits({ reference: "GK-20261123-ZZZZZZ", last4: "3210" })).rejects.toThrow(LOOKUP_FAILED);
  });
});

describe("guestTrackingLinkFor", () => {
  it("is null with the flags off, and for accounts not made by guest checkout", async () => {
    const guest = await createUser();
    await db.update(users).set({ guestCreated: true }).where(eq(users.id, guest.id));
    const regular = await createUser();
    expect(await guestTrackingLinkFor(guest.id)).toBeNull();
    await flagsOn();
    expect(await guestTrackingLinkFor(regular.id)).toBeNull();
    const link = await guestTrackingLinkFor(guest.id);
    const path = link!({ orderId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f", orderGroupId: null });
    expect(verifyTrackingToken(path.replace("/track/", ""))).toMatchObject({ ok: true, target: { kind: "O" } });
  });
});

describe("POST /api/cart/recommendation (guest)", () => {
  it("TC-SEC-001: a guest call with no cart lines is refused (422), not answered with an empty 200", async () => {
    await flagsOn();
    const { POST } = await import("@/app/api/cart/recommendation/route");
    const { NextRequest } = await import("next/server");
    const call = (body: unknown) =>
      POST(new NextRequest("http://localhost/api/cart/recommendation", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    expect((await call({})).status).toBe(422);
    expect((await call({ lines: [] })).status).toBe(422);
  });
});
