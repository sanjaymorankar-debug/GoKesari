/**
 * Release R2 (19-Nov-2026) against the real database:
 * D-131 — the Seller Central layout sends a signed-out visitor to sign in before the page streams
 *   (a real 307), except on the registration pages;
 * D-109 — it answers 404 for a packing slip that does not exist or is another shop's, before the
 *   page streams; the shop's own slip renders;
 * D-150 (production guest regression, 04-Nov / 16-Nov) — /api/admin/support-services and
 *   /api/admin/dealer-analytics refuse a guest with 401 and a customer with 403 while their
 *   feature is off, instead of 404.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
  path: "",
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(state.path ? { "x-gk-path": state.path } : {}),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/shop",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import SellerCentralLayout from "@/app/shop/layout";
import { GET as dealerAnalyticsGet, POST as dealerAnalyticsPost } from "@/app/api/admin/dealer-analytics/route";
import { GET as supportServicesGet, POST as supportServicesPost } from "@/app/api/admin/support-services/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { call } from "../helpers/http";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  state.session = null;
  state.path = "";
});

function signIn(user: { id: string; email: string }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: null, image: null, role, status: "ACTIVE" } };
}

const layout = (path: string) => {
  state.path = path;
  return SellerCentralLayout({ children: null });
};

describe("D-131: a signed-out visitor is sent to sign in by the Seller Central layout", () => {
  it.each(["/shop", "/shop/orders", "/shop/inventory", `/shop/orders/${UNKNOWN}/packing-slip`])("%s → /signin", async (path) => {
    await expect(layout(path)).rejects.toThrow("REDIRECT:/signin");
  });
  it.each(["/shop/register", "/shop/join/abc123"])("%s stays open (its own sign-in step)", async (path) => {
    await expect(layout(path)).resolves.toBeTruthy();
  });
});

describe("D-109: a packing slip that is not there answers 404 from the layout", () => {
  it("unknown order, another shop's order, and a malformed id → 404; the shop's own slip renders", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    const otherShop = await createShop(otherOwner.id);
    const customer = await createUser();
    const own = await createOrder(customer.id, shop.id, { status: "READY" });
    const theirs = await createOrder(customer.id, otherShop.id, { status: "READY" });
    signIn(owner, "SHOP_OWNER");

    await expect(layout(`/shop/orders/${UNKNOWN}/packing-slip`)).rejects.toThrow("NOT_FOUND");
    await expect(layout(`/shop/orders/${theirs.id}/packing-slip`)).rejects.toThrow("NOT_FOUND");
    await expect(layout("/shop/orders/not-an-id/packing-slip")).rejects.toThrow("NOT_FOUND");
    await expect(layout(`/shop/orders/${own.id}/packing-slip`)).resolves.toBeTruthy();
    await expect(layout("/shop/orders")).resolves.toBeTruthy();
  });
});

describe("caller before feature: admin APIs refuse a guest with 401 while the feature is off", () => {
  const routes = [
    ["GET /api/admin/support-services", supportServicesGet, "GET"],
    ["POST /api/admin/support-services", supportServicesPost, "POST"],
    ["GET /api/admin/dealer-analytics", dealerAnalyticsGet, "GET"],
    ["POST /api/admin/dealer-analytics", dealerAnalyticsPost, "POST"],
  ] as const;

  it.each(routes)("%s: guest 401, customer 403, admin 404 (feature off)", async (_name, handler, method) => {
    const body = method === "POST" ? {} : undefined;
    expect((await call(handler as never, "/api/admin/x", { method, body })).status).toBe(401);
    signIn(await createUser(), "CUSTOMER");
    expect((await call(handler as never, "/api/admin/x", { method, body })).status).toBe(403);
    signIn(await createUser({ role: "ADMIN" }), "ADMIN");
    expect((await call(handler as never, "/api/admin/x", { method, body })).status).toBe(404);
  });
});
