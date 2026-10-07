/**
 * Category master and shop ↔ category visibility — one test (or more) per
 * acceptance criterion of the category-management brief:
 *   - zero products without a category; General is permanent;
 *   - a shop with categories A and B sees exactly the products in A and B;
 *   - a product added to A later is visible to every shop with A, no extra step;
 *   - a shop owner cannot change another owner's shop's categories;
 *   - removing a category moves products to General and unlinks it from shops;
 *   - removing a category from a shop pauses its listings, never orders.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as categoriesPost, GET as categoriesGet } from "@/app/api/product-categories/route";
import { DELETE as categoryDelete } from "@/app/api/product-categories/[id]/route";
import { GET as shopCategoriesGet, POST as shopCategoryPost } from "@/app/api/shops/[id]/product-categories/route";
import { DELETE as shopCategoryDelete } from "@/app/api/shops/[id]/product-categories/[categoryId]/route";
import { db } from "@/server/db";
import { auditLogs, orderItems, orders, productCategories, products, shopProductCategories, users } from "@/server/db/schema";
import {
  createProductForShop,
  createShopProduct as listProductInShop,
  listStorefrontProducts,
  loadPurchasableShopProduct,
} from "@/server/services/catalogue";
import {
  addCategoryToShop,
  createProductCategory,
  ensureGeneralCategory,
  getCategoryRemovalImpact,
  listCategoryMaster,
  listProductsVisibleToShop,
  listShopProductCategories,
  removeCategoryFromShop,
  removeProductCategory,
  setProductCategory,
  updateProductCategory,
} from "@/server/services/product-categories";
import { call } from "../helpers/http";
import {
  createCategory,
  createOrder,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  linkShopCategory,
  resetDatabase,
} from "../helpers/fixtures";

const actor = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function visibleNames(shopId: string) {
  const { products: rows } = await listProductsVisibleToShop(shopId, { limit: 200 });
  return rows.map((r) => r.name).sort();
}

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

describe("General", () => {
  it("always exists, and cannot be removed, renamed or deactivated — not even with raw SQL", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const general = await ensureGeneralCategory();
    expect(general).toMatchObject({ name: "General", isSystem: true, isActive: true });
    expect((await ensureGeneralCategory()).id).toBe(general.id); // idempotent

    await expect(removeProductCategory(general.id, actor(admin))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateProductCategory(general.id, { name: "Misc" }, actor(admin))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateProductCategory(general.id, { isActive: false }, actor(admin))).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The database trigger is the backstop for any path that skips the service.
    await expect(db.execute(sql`DELETE FROM product_categories WHERE id = ${general.id}`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE product_categories SET name = 'Other' WHERE id = ${general.id}`)).rejects.toThrow();
    await expect(db.execute(sql`UPDATE product_categories SET deleted_at = now() WHERE id = ${general.id}`)).rejects.toThrow();
  });

  it("is refused over HTTP too", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const general = await ensureGeneralCategory();
    signIn(admin);
    const res = await call(categoryDelete, `/api/product-categories/${general.id}`, { method: "DELETE", params: { id: general.id } });
    expect(res.status).toBe(403);
  });
});

describe("category master", () => {
  it("lets admin, operator and shop owner add categories, with case-insensitive unique names", async () => {
    for (const role of ["ADMIN", "OPERATOR", "SHOP_OWNER"] as const) {
      const u = await createUser({ role });
      const c = await createProductCategory({ name: `Cat ${role}` }, actor(u));
      expect(c.createdBy).toBe(u.id);
    }
    const admin = await createUser({ role: "ADMIN" });
    await createProductCategory({ name: "Snacks" }, actor(admin));
    await expect(createProductCategory({ name: "  sNaCkS " }, actor(admin))).rejects.toMatchObject({ code: "CONFLICT" });

    const customer = await createUser({ role: "CUSTOMER" });
    signIn(customer);
    const res = await call(categoriesPost, "/api/product-categories", { method: "POST", body: { name: "Mine" } });
    expect(res.status).toBe(403);

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "product_category.created")).limit(1);
    expect(audit?.actorId).toBeTruthy();
  });

  it("lists categories for every operational role, and not for customers", async () => {
    await ensureGeneralCategory();
    for (const role of ["ADMIN", "OPERATOR", "SHOP_OWNER"] as const) {
      signIn(await createUser({ role }));
      const res = await call(categoriesGet, "/api/product-categories");
      expect(res.status).toBe(200);
      expect(res.body.categories[0].name).toBe("General"); // General first
    }
    signIn(await createUser({ role: "CUSTOMER" }));
    expect((await call(categoriesGet, "/api/product-categories")).status).toBe(403);
  });

  it("removing a category moves its products to General, unlinks it from every shop, and is audited", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const general = await ensureGeneralCategory();
    const snacks = await createCategory({ name: "Snacks", department: "CONVENIENCE_STORE" });
    const chips = await createProduct(snacks.id, { name: "Chips" });
    const wafers = await createProduct(snacks.id, { name: "Wafers" });
    const shopA = await createShop((await createUser({ role: "SHOP_OWNER" })).id);
    const shopB = await createShop((await createUser({ role: "SHOP_OWNER" })).id);
    await createShopProduct(shopA.id, chips.id); // shopA lists chips (and so carries Snacks)
    await linkShopCategory(shopB.id, snacks.id);

    const impact = await getCategoryRemovalImpact(snacks.id);
    expect(impact).toMatchObject({ productCount: 2, shopCount: 2, listingsAtRisk: 1, shopsNeedingGeneral: 1 });

    const result = await removeProductCategory(snacks.id, actor(admin));
    expect(result).toMatchObject({ movedProducts: 2, unlinkedShops: 2, generalAddedToShops: 1 });

    const moved = await db.select({ categoryId: products.categoryId }).from(products);
    expect(moved.every((p) => p.categoryId === general.id)).toBe(true);
    expect(await db.select().from(products)).toHaveLength(2); // nothing deleted
    expect(await db.select().from(shopProductCategories).where(eq(shopProductCategories.categoryId, snacks.id))).toHaveLength(0);
    const [removed] = await db.select().from(productCategories).where(eq(productCategories.id, snacks.id));
    expect(removed.deletedAt).not.toBeNull();

    // keepListingsVisible: shop A still sells chips, now via General.
    expect((await listStorefrontProducts({ shopId: shopA.id })).map((p) => p.productName)).toEqual(["Chips"]);
    void wafers;

    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "product_category.removed"));
    expect(audit).toMatchObject({ actorId: admin.id, entityId: snacks.id });

    // Zero products without a live category.
    const [{ n }] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM products p JOIN product_categories c ON c.id = p.category_id
       WHERE p.deleted_at IS NULL AND c.deleted_at IS NOT NULL`);
    expect(n).toBe(0);
  });

  it("counts each category's own products and shops (not every row)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER", name: "Asha" });
    const shop = await createShop(owner.id);
    const a = await createProductCategory({ name: "Alpha" }, actor(owner));
    const b = await createCategory({ name: "Beta" });
    await createProduct(a.id, { name: "A1" });
    await createProduct(a.id, { name: "A2" });
    await createProduct(b.id, { name: "B1" });
    await addCategoryToShop(shop.id, a.id, actor(owner));

    const rows = await listCategoryMaster(actor(owner));
    expect(rows.find((r) => r.name === "Alpha")).toMatchObject({ productCount: 2, shopCount: 1, createdByName: "Asha" });
    expect(rows.find((r) => r.name === "Beta")).toMatchObject({ productCount: 1, shopCount: 0, createdByName: null });
    expect(await listShopProductCategories(shop.id, actor(owner))).toEqual([
      expect.objectContaining({ name: "Alpha", productCount: 2, addedByName: "Asha" }),
    ]);
  });

  it("lets a shop owner remove only a category they created that no other owner's shop carries", async () => {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    const shopA = await createShop(ownerA.id);
    const shopB = await createShop(ownerB.id);
    await ensureGeneralCategory();

    const mine = await createProductCategory({ name: "Organic" }, actor(ownerA));
    await addCategoryToShop(shopA.id, mine.id, actor(ownerA));
    const staffs = await createProductCategory({ name: "Dairy" }, actor(operator));
    const shared = await createProductCategory({ name: "Pooja Items" }, actor(ownerA));
    await addCategoryToShop(shopB.id, shared.id, actor(ownerB));

    await expect(removeProductCategory(staffs.id, actor(ownerA))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(removeProductCategory(shared.id, actor(ownerA))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(removeProductCategory(mine.id, actor(ownerA))).resolves.toMatchObject({ unlinkedShops: 1 });
    await expect(removeProductCategory(shared.id, actor(operator))).resolves.toMatchObject({ unlinkedShops: 1 });
  });
});

describe("who added a category, as other people see it", () => {
  async function withoutName<T extends { id: string }>(user: T): Promise<T> {
    await db.update(users).set({ name: null }).where(eq(users.id, user.id));
    return user;
  }

  it("the category master never shows an email or the creator's id, and says who may manage each row", async () => {
    const creator = await withoutName(await createUser({ role: "SHOP_OWNER", email: "nameless-owner@test.local" }));
    const viewer = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR", name: "Priya Ops" });
    const namelessOperator = await withoutName(await createUser({ role: "OPERATOR", email: "nameless-ops@test.local" }));
    const admin = await createUser({ role: "ADMIN" });
    await createProductCategory({ name: "Owner Made" }, actor(creator));
    await createProductCategory({ name: "Staff Made" }, actor(operator));
    await createProductCategory({ name: "Quiet Staff Made" }, actor(namelessOperator));

    const listAs = async (user: Parameters<typeof signIn>[0]) => {
      signIn(user);
      const res = await call(categoriesGet, "/api/product-categories");
      expect(res.status).toBe(200);
      return res.body.categories as Record<string, unknown>[];
    };

    const seenByOwner = await listAs(viewer);
    const text = JSON.stringify(seenByOwner);
    expect(text).not.toContain("nameless-owner@test.local");
    expect(text).not.toContain("nameless-ops@test.local");
    expect(text).not.toContain(creator.id);
    expect(text).not.toContain(operator.id);
    for (const row of seenByOwner) expect(row).not.toHaveProperty("createdBy");
    const byName = (rows: Record<string, unknown>[], name: string) => rows.find((r) => r.name === name);
    expect(byName(seenByOwner, "Owner Made")).toMatchObject({ createdByName: "a shop owner", canManage: false });
    // Staff are the GoKesari team to shop owners, named or not.
    expect(byName(seenByOwner, "Staff Made")).toMatchObject({ createdByName: "the GoKesari team", canManage: false });
    expect(byName(seenByOwner, "Quiet Staff Made")).toMatchObject({ createdByName: "the GoKesari team", canManage: false });
    expect(byName(seenByOwner, "General")).toMatchObject({ canManage: false });

    // The creator may manage their own category; nothing else changed for them.
    const seenByCreator = await listAs(creator);
    expect(byName(seenByCreator, "Owner Made")).toMatchObject({ canManage: true });
    expect(byName(seenByCreator, "Staff Made")).toMatchObject({ canManage: false });

    // Staff still see each other's names, and manage everything but General.
    const seenByAdmin = await listAs(admin);
    expect(JSON.stringify(seenByAdmin)).not.toContain("@test.local");
    expect(byName(seenByAdmin, "Staff Made")).toMatchObject({ createdByName: "Priya Ops", canManage: true });
    expect(byName(seenByAdmin, "Quiet Staff Made")).toMatchObject({ createdByName: "the GoKesari team", canManage: true });
    expect(byName(seenByAdmin, "Owner Made")).toMatchObject({ createdByName: "a shop owner", canManage: true });
    expect(byName(seenByAdmin, "General")).toMatchObject({ canManage: false });
  });

  it("a shop's categories show staff as the GoKesari team to the owner, never an email", async () => {
    const owner = await withoutName(await createUser({ role: "SHOP_OWNER", email: "nameless-shop@test.local" }));
    const operator = await createUser({ role: "OPERATOR", name: "Priya Ops", email: "priya-ops@test.local" });
    const admin = await createUser({ role: "ADMIN" });
    const shop = await createShop(owner.id);
    const mine = await createCategory({ name: "Mine" });
    const theirs = await createCategory({ name: "Theirs" });
    await addCategoryToShop(shop.id, mine.id, actor(owner));
    await addCategoryToShop(shop.id, theirs.id, actor(operator));

    signIn(owner);
    const res = await call(shopCategoriesGet, `/api/shops/${shop.id}/product-categories`, { params: { id: shop.id } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("@test.local");
    expect(JSON.stringify(res.body)).not.toContain("Priya Ops");
    expect(res.body.categories).toEqual([
      expect.objectContaining({ name: "Mine", addedByName: "a shop owner" }),
      expect.objectContaining({ name: "Theirs", addedByName: "the GoKesari team" }),
    ]);

    // The operations page keeps the staff member's name.
    expect(await listShopProductCategories(shop.id, actor(admin))).toEqual([
      expect.objectContaining({ name: "Mine", addedByName: "a shop owner" }),
      expect.objectContaining({ name: "Theirs", addedByName: "Priya Ops" }),
    ]);
  });
});

describe("shop visibility", () => {
  it("a shop with categories A and B sees exactly the products in A and B", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const a = await createCategory({ name: "A" });
    const b = await createCategory({ name: "B" });
    const c = await createCategory({ name: "C" });
    await createProduct(a.id, { name: "A1" });
    await createProduct(a.id, { name: "A2" });
    await createProduct(b.id, { name: "B1" });
    await createProduct(c.id, { name: "C1" });
    // An unapproved product in A stays hidden (the approval gate still holds).
    const [pending] = await db.insert(products).values({ categoryId: a.id, name: "A-pending", slug: "a-pending", unit: "unit", approvalStatus: "PENDING_APPROVAL" }).returning();
    void pending;

    await addCategoryToShop(shop.id, a.id, actor(owner));
    await addCategoryToShop(shop.id, b.id, actor(owner));
    expect(await visibleNames(shop.id)).toEqual(["A1", "A2", "B1"]);

    // Adding the same category twice is a no-op, not a duplicate row.
    expect((await addCategoryToShop(shop.id, a.id, actor(owner))).added).toBe(false);
    expect(await db.select().from(shopProductCategories).where(eq(shopProductCategories.shopId, shop.id))).toHaveLength(2);
    // ...and the junction's unique constraint refuses a duplicate outright.
    await expect(db.insert(shopProductCategories).values({ shopId: shop.id, categoryId: a.id })).rejects.toThrow();
  });

  it("a product added to category A later is visible to every shop with A, with no extra step", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const a = await createCategory({ name: "A" });
    const b = await createCategory({ name: "B" });
    const shops = await Promise.all([1, 2, 3].map(async () => createShop((await createUser({ role: "SHOP_OWNER" })).id)));
    await linkShopCategory(shops[0].id, a.id);
    await linkShopCategory(shops[1].id, a.id);
    await linkShopCategory(shops[2].id, b.id);

    await createProduct(a.id, { name: "Brand New" });
    expect(await visibleNames(shops[0].id)).toEqual(["Brand New"]);
    expect(await visibleNames(shops[1].id)).toEqual(["Brand New"]);
    expect(await visibleNames(shops[2].id)).toEqual([]);

    // Moving a product into A has the same effect.
    const moved = await createProduct(b.id, { name: "Mover" });
    await setProductCategory(moved.id, a.id, actor(operator));
    expect(await visibleNames(shops[1].id)).toEqual(["Brand New", "Mover"]);
  });

  it("a shop owner cannot change categories for another owner's shop; staff can for any shop", async () => {
    const ownerA = await createUser({ role: "SHOP_OWNER" });
    const ownerB = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    const shopB = await createShop(ownerB.id);
    const a = await createCategory({ name: "A" });
    await linkShopCategory(shopB.id, a.id);

    await expect(addCategoryToShop(shopB.id, a.id, actor(ownerA))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(removeCategoryFromShop(shopB.id, a.id, actor(ownerA))).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Over HTTP: the server refuses regardless of what the UI shows.
    signIn(ownerA);
    const post = await call(shopCategoryPost, `/api/shops/${shopB.id}/product-categories`, {
      method: "POST",
      body: { categoryId: a.id },
      params: { id: shopB.id },
    });
    expect(post.status).toBe(403);
    const del = await call(shopCategoryDelete, `/api/shops/${shopB.id}/product-categories/${a.id}`, {
      method: "DELETE",
      params: { id: shopB.id, categoryId: a.id },
    });
    expect(del.status).toBe(403);
    expect(await db.select().from(shopProductCategories).where(eq(shopProductCategories.shopId, shopB.id))).toHaveLength(1);

    // Its owner, and operations, may.
    signIn(ownerB);
    expect(
      (await call(shopCategoryDelete, `/api/shops/${shopB.id}/product-categories/${a.id}`, { method: "DELETE", params: { id: shopB.id, categoryId: a.id } })).status,
    ).toBe(200);
    signIn(operator);
    expect(
      (await call(shopCategoryPost, `/api/shops/${shopB.id}/product-categories`, { method: "POST", body: { categoryId: a.id }, params: { id: shopB.id } })).status,
    ).toBe(201);
    const actions = (await db.select({ action: auditLogs.action }).from(auditLogs)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["shop.product_category_added", "shop.product_category_removed"]));
  });

  it("removing a category from a shop pauses its listings in it, leaves orders alone, and re-adding restores them", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const customer = await createUser({ role: "CUSTOMER" });
    const shop = await createShop(owner.id);
    const milk = await createCategory({ name: "Milk" });
    const product = await createProduct(milk.id, { name: "Cow Milk" });
    const listing = await createShopProduct(shop.id, product.id);
    const order = await createOrder(customer.id, shop.id, { status: "DELIVERED" });
    await db.insert(orderItems).values({
      orderId: order.id,
      shopProductId: listing.id,
      productNameSnapshot: "Cow Milk",
      unitSnapshot: "L",
      unitPricePaise: 7000,
      quantityMilli: 1000,
      lineTotalPaise: 7000,
    });

    expect(await listStorefrontProducts({ shopId: shop.id })).toHaveLength(1);
    const { pausedListings } = await removeCategoryFromShop(shop.id, milk.id, actor(owner));
    expect(pausedListings).toBe(1);

    expect(await listStorefrontProducts({ shopId: shop.id })).toHaveLength(0);
    await expect(loadPurchasableShopProduct(listing.id, 1)).rejects.toMatchObject({ code: "PRODUCT_NOT_PURCHASABLE_ONLINE" });
    // The listing and the order history are untouched.
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.status).toBe("DELIVERED");
    expect(await db.select().from(orderItems).where(eq(orderItems.orderId, order.id))).toHaveLength(1);

    await addCategoryToShop(shop.id, milk.id, actor(owner));
    expect(await listStorefrontProducts({ shopId: shop.id })).toHaveLength(1);
    await expect(loadPurchasableShopProduct(listing.id, 1)).resolves.toMatchObject({ unitPricePaise: 7000 });
  });

  it("refuses to list a product in a category the shop does not carry", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const c = await createCategory({ name: "Stationery", department: "STATIONERY_STORE" });
    const pen = await createProduct(c.id, { name: "Pen" });
    const input = { shopId: shop.id, productId: pen.id, onlineSaleEnabled: true, offlineSaleEnabled: false, onlinePricePaise: 1000 };
    await expect(listProductInShop(input, { id: owner.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await linkShopCategory(shop.id, c.id);
    await expect(listProductInShop(input, { id: owner.id, role: "SHOP_OWNER" })).resolves.toBeTruthy();
  });
});

describe("product add/edit", () => {
  it("defaults a new product to General and makes the shop carry the chosen category", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const general = await ensureGeneralCategory();

    const { product } = await createProductForShop({ shopId: shop.id, name: "Handmade Diya", unit: "piece" }, actor(owner), true);
    expect(product.categoryId).toBe(general.id);
    const [link] = await db
      .select()
      .from(shopProductCategories)
      .where(and(eq(shopProductCategories.shopId, shop.id), eq(shopProductCategories.categoryId, general.id)));
    expect(link?.addedBy).toBe(owner.id);
  });

  it("lets staff move any product, and an owner only their own unapproved product", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const operator = await createUser({ role: "OPERATOR" });
    const shop = await createShop(owner.id);
    const a = await createCategory({ name: "A" });
    const b = await createCategory({ name: "B" });
    const published = await createProduct(a.id, { name: "Published" });
    const { product: own } = await createProductForShop({ shopId: shop.id, categoryId: a.id, name: "Own Thing", unit: "piece" }, actor(owner), true);

    await expect(setProductCategory(published.id, b.id, actor(owner))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(setProductCategory(own.id, b.id, actor(owner))).resolves.toMatchObject({ categoryId: b.id, shopsLinked: 1 });
    await expect(setProductCategory(published.id, b.id, actor(operator))).resolves.toMatchObject({ categoryId: b.id });
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "product.category_changed")).limit(1);
    expect(audit).toBeTruthy();
  });
});

describe("refused product creation", () => {
  it("links no category when creation is refused as a likely duplicate", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id);
    const c = await createCategory({ name: "Snacks", department: "CONVENIENCE_STORE" });
    await createProduct(c.id, { name: "Potato Chips Classic" });
    await expect(
      createProductForShop({ shopId: shop.id, categoryId: c.id, name: "Potato Chips Clasic", unit: "pack" }, actor(owner), true),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(shopProductCategories).where(eq(shopProductCategories.shopId, shop.id))).toHaveLength(0);
  });
});
