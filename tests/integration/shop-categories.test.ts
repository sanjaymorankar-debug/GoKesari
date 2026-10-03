/**
 * Shop categories: many-to-many mapping, owner/admin editing, search relevance,
 * uncategorised flagging, and independence from shop type and products.
 */
import { eq, sql } from "drizzle-orm";
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
      status: "ACTIVE";
    };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import {
  PUT as shopCategoriesPut,
  GET as shopCategoriesGet,
} from "@/app/api/shops/[id]/categories/route";
import {
  GET as categoriesGet,
  POST as categoriesPost,
} from "@/app/api/shop-categories/route";
import { PATCH as categoryPatch } from "@/app/api/shop-categories/[id]/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  shopCategories,
  shopCategoryMapping,
  shopProducts,
} from "@/server/db/schema";
import {
  applyShopCategories,
  getShopCategories,
  listShopsInCategory,
  listUncategorisedShops,
} from "@/server/services/shop-categories";
import { searchShops } from "@/server/services/shops";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { insertReturning } from "@/server/db/returning";

function signIn(user: {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}) {
  state.session = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: null,
      role: user.role,
      status: "ACTIVE",
    },
  };
}

async function someCategories(n: number) {
  const rows = await db
    .select()
    .from(shopCategories)
    .where(eq(shopCategories.status, "ACTIVE"))
    .limit(n);
  expect(rows.length).toBe(n);
  return rows;
}

beforeEach(async () => {
  state.session = null;
  resetRateLimits();
  await resetDatabase();
});

describe("seeded categories", () => {
  it("exist after migration and are listed for pickers without auth", async () => {
    const res = await call(categoriesGet, "/api/shop-categories");
    expect(res.status).toBe(200);
    expect(res.body.categories.length).toBeGreaterThan(10);
    expect(res.body.categories[0]).not.toHaveProperty("shopCount");
  });

  it("filters by search text", async () => {
    const res = await call(categoriesGet, "/api/shop-categories?q=dairy");
    expect(res.body.categories.length).toBeGreaterThan(0);
    for (const c of res.body.categories)
      expect(c.name.toLowerCase()).toContain("dairy");
  });
});

describe("a shop's categories", () => {
  it("supports several categories and requires at least one", async () => {
    const owner = await createUser();
    const shop = await createShop(owner.id);
    const [a, b, c] = await someCategories(3);
    signIn(owner);

    const empty = await call(
      shopCategoriesPut,
      `/api/shops/${shop.id}/categories`,
      {
        method: "PUT",
        params: { id: shop.id },
        body: { categoryIds: [] },
      },
    );
    expect(empty.status).toBe(422);
    expect(JSON.stringify(empty.body)).toContain(
      "Please select at least one shop category.",
    );

    const set = await call(
      shopCategoriesPut,
      `/api/shops/${shop.id}/categories`,
      {
        method: "PUT",
        params: { id: shop.id },
        body: { categoryIds: [a.id, b.id, c.id] },
      },
    );
    expect(set.status).toBe(200);
    expect(set.body.categories).toHaveLength(3);

    // remove one, keep two
    const trimmed = await call(
      shopCategoriesPut,
      `/api/shops/${shop.id}/categories`,
      {
        method: "PUT",
        params: { id: shop.id },
        body: { categoryIds: [a.id, b.id] },
      },
    );
    expect(trimmed.body.categories).toHaveLength(2);
    const got = await call(
      shopCategoriesGet,
      `/api/shops/${shop.id}/categories`,
      { params: { id: shop.id } },
    );
    expect(got.body.categories.map((x: { id: string }) => x.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });

  it("does not let another customer edit someone else's shop categories", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const shop = await createShop(owner.id);
    const [a] = await someCategories(1);
    signIn(stranger);
    const res = await call(
      shopCategoriesPut,
      `/api/shops/${shop.id}/categories`,
      {
        method: "PUT",
        params: { id: shop.id },
        body: { categoryIds: [a.id] },
      },
    );
    expect([403, 404]).toContain(res.status);
    expect(await getShopCategories(shop.id)).toHaveLength(0);
  });

  it("lets an admin assign categories to any shop and see the shop under each", async () => {
    const owner = await createUser();
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id);
    const [a, b] = await someCategories(2);
    signIn(admin);
    const res = await call(
      shopCategoriesPut,
      `/api/shops/${shop.id}/categories`,
      {
        method: "PUT",
        params: { id: shop.id },
        body: { categoryIds: [a.id, b.id] },
      },
    );
    expect(res.status).toBe(200);
    expect((await listShopsInCategory(a.id)).map((s) => s.id)).toContain(
      shop.id,
    );
    expect((await listShopsInCategory(b.id)).map((s) => s.id)).toContain(
      shop.id,
    );
  });

  it("leaves products untouched when categories change", async () => {
    const owner = await createUser();
    const shop = await createShop(owner.id);
    const [a, b] = await someCategories(2);
    await applyShopCategories(db, shop.id, [a.id]);
    const before = await db
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.shopId, shop.id));
    await applyShopCategories(db, shop.id, [b.id]);
    const after = await db
      .select()
      .from(shopProducts)
      .where(eq(shopProducts.shopId, shop.id));
    expect(after).toEqual(before);
  });
});

describe("category management (staff)", () => {
  it("creates, renames, deactivates; customers cannot", async () => {
    // shop_categories survives resetDatabase, so clear leftovers from earlier runs.
    await db
      .delete(shopCategories)
      .where(sql`${shopCategories.slug} in ('pet-supplies-x', 'pet-care-x')`);
    const admin = await createUser({ role: "ADMIN" });
    const customer = await createUser();

    signIn(customer);
    const denied = await call(categoriesPost, "/api/shop-categories", {
      method: "POST",
      body: { name: "Pet Supplies X" },
    });
    expect(denied.status).toBe(403);

    signIn(admin);
    const created = await call(categoriesPost, "/api/shop-categories", {
      method: "POST",
      body: { name: "Pet Supplies X" },
    });
    expect(created.status).toBe(201);
    const dup = await call(categoriesPost, "/api/shop-categories", {
      method: "POST",
      body: { name: "pet supplies x" },
    });
    expect(dup.status).toBe(409);

    const renamed = await call(
      categoryPatch,
      `/api/shop-categories/${created.body.id}`,
      {
        method: "PATCH",
        params: { id: created.body.id },
        body: { name: "Pet Care X" },
      },
    );
    expect(renamed.body.name).toBe("Pet Care X");
    expect(renamed.body.slug).toBe(created.body.slug);

    await call(categoryPatch, `/api/shop-categories/${created.body.id}`, {
      method: "PATCH",
      params: { id: created.body.id },
      body: { status: "INACTIVE" },
    });
    const list = await call(categoriesGet, "/api/shop-categories");
    expect(list.body.categories.map((c: { id: string }) => c.id)).not.toContain(
      created.body.id,
    );

    // a retired category cannot be newly chosen
    const owner = await createUser();
    const shop = await createShop(owner.id);
    await expect(
      applyShopCategories(db, shop.id, [created.body.id]),
    ).rejects.toThrow();
    await db
      .delete(shopCategories)
      .where(eq(shopCategories.id, created.body.id));
  });

  it("lets an existing retired category stay on a shop", async () => {
    const owner = await createUser();
    const shop = await createShop(owner.id);
    const [a, b] = await someCategories(2);
    await applyShopCategories(db, shop.id, [a.id, b.id]);
    await db
      .update(shopCategories)
      .set({ status: "INACTIVE" })
      .where(eq(shopCategories.id, a.id));
    await applyShopCategories(db, shop.id, [a.id, b.id]);
    expect(await getShopCategories(shop.id)).toHaveLength(2);
    await db
      .update(shopCategories)
      .set({ status: "ACTIVE" })
      .where(eq(shopCategories.id, a.id));
  });
});

describe("uncategorised shops and search", () => {
  it("flags shops with no category until one is assigned", async () => {
    const owner = await createUser();
    const shop = await createShop(owner.id);
    expect((await listUncategorisedShops()).map((s) => s.id)).toContain(
      shop.id,
    );
    const [a] = await someCategories(1);
    await applyShopCategories(db, shop.id, [a.id]);
    expect((await listUncategorisedShops()).map((s) => s.id)).not.toContain(
      shop.id,
    );
  });

  it("finds a shop by one of its category names and by categoryId filter", async () => {
    const owner = await createUser();
    const shop = await createShop(owner.id, {
      status: "APPROVED",
      name: "Zzqx Stores",
    });
    const [created] = await insertReturning(db, shopCategories, {
      name: "Quokka Feed",
      slug: "quokka-feed",
    });
    await applyShopCategories(db, shop.id, [created.id]);

    const byText = await searchShops({ query: "quokka" });
    expect(byText.map((s) => s.id)).toContain(shop.id);
    const byId = await searchShops({ categoryId: created.id });
    expect(byId.map((s) => s.id)).toEqual([shop.id]);

    await db
      .delete(shopCategoryMapping)
      .where(eq(shopCategoryMapping.categoryId, created.id));
    await db.delete(shopCategories).where(eq(shopCategories.id, created.id));
  });
});
