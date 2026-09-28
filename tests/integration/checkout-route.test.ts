/**
 * Route-level tests for POST /api/checkout (Phase 1a — see
 * docs/gokesari-audit/GOKESARI_IMPLEMENTATION_ROADMAP.md and GAP-006). The
 * checkout SERVICE is already well covered (tests/integration/checkout.test.ts);
 * this file covers the route layer on top of it — auth, validation, status
 * codes, and that idempotency survives an actual HTTP round trip, not just a
 * direct service call.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: UserRole;
      status: "ACTIVE" | "SUSPENDED" | "DELETED";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as checkoutRoute } from "@/app/api/checkout/route";
import { db } from "@/server/db";
import { wallets } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  resetDatabase,
} from "../helpers/fixtures";

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
});

function signInAsUser(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
}

const balanceOf = async (userId: string) =>
  (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))!.balancePaise;

async function shopSetup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const category = await createCategory({ department: "DAIRY", name: "Milk" });
  const product = await createProduct(category.id, { name: "Cow Milk", unit: "L" });
  const shop = await createShop(owner.id);
  const shopProduct = await createShopProduct(shop.id, product.id, {
    onlinePricePaise: 7000,
    onlineStock: 50,
  });
  return { owner, shop, shopProduct };
}

describe("POST /api/checkout", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const r = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-anon-1" },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a missing requestId with 422", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    signInAsUser({ ...customer, role: "CUSTOMER" });

    const r = await call(checkoutRoute, "/api/checkout", { method: "POST", body: {} });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects checkout with an empty cart", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    signInAsUser({ ...customer, role: "CUSTOMER" });

    const r = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-empty-1" },
    });
    expect(r.status).toBe(422);
  });

  it("places an order, debits the wallet, and returns 201 with the order summary", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const { shopProduct } = await shopSetup();
    await addToCart(customer.id, shopProduct.id, 2);

    signInAsUser({ ...customer, role: "CUSTOMER" });
    const r = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-success-1" },
    });

    expect(r.status).toBe(201);
    expect(r.body.orders).toHaveLength(1);
    expect(r.body.orders[0].totalPaise).toBe(14000);
    expect(r.body.orders[0].status).toBe("CONFIRMED");
    expect(r.body.deduplicated).toBe(false);
    expect(await balanceOf(customer.id)).toBe(500_000 - 14000);
  });

  it("returns 402 with the shortfall when the wallet balance is insufficient", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 5000 }); // ₹50, order costs ₹70
    const { shopProduct } = await shopSetup();
    await addToCart(customer.id, shopProduct.id, 1);

    signInAsUser({ ...customer, role: "CUSTOMER" });
    const r = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-shortfall-1" },
    });

    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("INSUFFICIENT_BALANCE");
    expect(r.body.error.details.shortfallPaise).toBe(2000);
    // Nothing was created or consumed on a failed checkout.
    expect(await balanceOf(customer.id)).toBe(5000);
  });

  it("re-submitting the same requestId returns the original order instead of charging twice", async () => {
    const { user: customer } = await createUserWithWallet({ balancePaise: 500_000 });
    const { shopProduct } = await shopSetup();
    await addToCart(customer.id, shopProduct.id, 1);
    signInAsUser({ ...customer, role: "CUSTOMER" });

    const first = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-dedup-1" },
    });
    expect(first.status).toBe(201);
    expect(first.body.deduplicated).toBe(false);
    const balanceAfterFirst = await balanceOf(customer.id);

    const second = await call(checkoutRoute, "/api/checkout", {
      method: "POST",
      body: { requestId: "req-dedup-1" },
    });
    expect(second.status).toBe(201);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.orders[0].id).toBe(first.body.orders[0].id);
    expect(await balanceOf(customer.id)).toBe(balanceAfterFirst); // not charged again
  });
});
