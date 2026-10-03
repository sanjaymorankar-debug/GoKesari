/**
 * Category master and shop ↔ category assignment.
 *
 * Every product sits in exactly one `product_categories` row. A shop carries
 * any number of categories (`shop_product_categories`) and sees every product
 * in them — computed at query time, so a product added to a category later is
 * visible to every shop carrying it with no per-product step.
 *
 * Rules enforced here (and, for General, again by a database trigger):
 *   - "General" always exists and can never be removed, renamed or deactivated.
 *   - Removing a category never deletes a product: its products move to
 *     General and the category is unlinked from every shop.
 *   - Admin/Operator manage any category and any shop's categories. A shop
 *     owner adds categories, manages categories on their own shops only, and
 *     may edit/remove only a category they created that no other owner's shop
 *     carries.
 *   - Unlinking a category from a shop pauses that shop's listings in it on the
 *     storefront (see `shopCarriesProductCategory`); listings, orders and
 *     history are never touched, and re-adding the category restores them.
 */
import { and, asc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  brands,
  productCategories,
  productSubcategories,
  products,
  shopProductCategories,
  shopProducts,
  shops,
  users,
  type Department,
  type ProductCategory,
  type UserRole,
} from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

export interface CategoryActor {
  id: string;
  role: UserRole;
}

export const GENERAL_CATEGORY_NAME = "General";
const GENERAL_DEPARTMENT: Department = "GENERAL_TRADING";

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/**
 * The shop carries the category this product is in. Used as a WHERE fragment
 * by the storefront and purchasability checks, so a shop's listing is only
 * sellable while the shop carries the listing's category.
 */
export function shopCarriesProductCategory(shopId: AnyPgColumn | string, categoryIdColumn: AnyPgColumn): SQL {
  return sql`EXISTS (SELECT 1 FROM ${shopProductCategories}
    WHERE ${shopProductCategories.shopId} = ${shopId}
      AND ${shopProductCategories.categoryId} = ${categoryIdColumn})`;
}

/* ---------------------------------------------------------------- General */

/**
 * Returns the General category, creating it if it is missing (a brand-new
 * database, or a test run that truncated the table). If a live category named
 * "general" exists it is adopted rather than duplicated.
 */
export async function ensureGeneralCategory(client: DbClient = db): Promise<ProductCategory> {
  const find = () =>
    client
      .select()
      .from(productCategories)
      .where(and(eq(productCategories.isSystem, true), isNull(productCategories.deletedAt)))
      .limit(1);
  const [existing] = await find();
  if (existing) return existing;

  const [namesake] = await client
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(and(sql`lower(${productCategories.name}) = 'general'`, isNull(productCategories.deletedAt)))
    .limit(1);
  if (namesake) {
    await client
      .update(productCategories)
      .set({ isSystem: true, name: GENERAL_CATEGORY_NAME, isActive: true, updatedAt: new Date() })
      .where(eq(productCategories.id, namesake.id));
  } else {
    const [slugTaken] = await client
      .select({ id: productCategories.id })
      .from(productCategories)
      .where(eq(productCategories.slug, "general"))
      .limit(1);
    await client
      .insert(productCategories)
      .values({
        department: GENERAL_DEPARTMENT,
        name: GENERAL_CATEGORY_NAME,
        slug: slugTaken ? `general-${crypto.randomUUID().slice(0, 8)}` : "general",
        description: "Products that do not clearly fit another category.",
        sortOrder: 9999,
        isSystem: true,
      })
      .onConflictDoNothing();
  }
  const [created] = await find();
  if (!created) throw new Error("Could not create the General category.");
  return created;
}

/* --------------------------------------------------------- category master */

export interface CategoryMasterRow {
  id: string;
  name: string;
  description: string | null;
  department: Department;
  isActive: boolean;
  isSystem: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
  productCount: number;
  shopCount: number;
}

export async function listCategoryMaster(
  options: { query?: string; includeInactive?: boolean } = {},
  client: DbClient = db,
): Promise<CategoryMasterRow[]> {
  await ensureGeneralCategory(client);
  const q = options.query?.trim();
  return client
    .select({
      id: productCategories.id,
      name: productCategories.name,
      description: productCategories.description,
      department: productCategories.department,
      isActive: productCategories.isActive,
      isSystem: productCategories.isSystem,
      createdBy: productCategories.createdBy,
      createdByName: sql<string | null>`(SELECT coalesce(${users.name}, ${users.email}) FROM ${users} WHERE ${users.id} = ${productCategories.createdBy})`,
      createdAt: productCategories.createdAt,
      productCount: sql<number>`(SELECT count(*)::int FROM ${products} p
        WHERE p.category_id = ${productCategories.id} AND p.deleted_at IS NULL)`,
      shopCount: sql<number>`(SELECT count(*)::int FROM ${shopProductCategories} l JOIN ${shops} s ON s.id = l.shop_id
        WHERE l.category_id = ${productCategories.id} AND s.deleted_at IS NULL)`,
    })
    .from(productCategories)
    .where(
      and(
        isNull(productCategories.deletedAt),
        options.includeInactive ? undefined : eq(productCategories.isActive, true),
        q ? or(ilike(productCategories.name, `%${q}%`), ilike(productCategories.description, `%${q}%`)) : undefined,
      ),
    )
    .orderBy(sql`${productCategories.isSystem} DESC`, asc(productCategories.name));
}

async function loadLiveCategory(id: string, client: DbClient = db): Promise<ProductCategory> {
  const [category] = await client
    .select()
    .from(productCategories)
    .where(and(eq(productCategories.id, id), isNull(productCategories.deletedAt)));
  if (!category) throw notFound("Category");
  return category;
}

function validateName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw validationFailed("A category name needs 2–80 characters.");
  if (!slugify(name)) throw validationFailed("Use letters or numbers in the category name.");
  return name;
}

async function assertNameFree(name: string, exceptId: string | null, client: DbClient): Promise<void> {
  const [clash] = await client
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(
      and(
        sql`lower(${productCategories.name}) = ${name.toLowerCase()}`,
        isNull(productCategories.deletedAt),
        exceptId ? ne(productCategories.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  if (clash) throw conflict(`A category called "${name}" already exists.`);
}

async function freeSlug(name: string, client: DbClient): Promise<string> {
  const base = slugify(name);
  const [taken] = await client
    .select({ id: productCategories.id })
    .from(productCategories)
    .where(eq(productCategories.slug, base))
    .limit(1);
  return taken ? `${base}-${crypto.randomUUID().slice(0, 6)}` : base;
}

export async function createProductCategory(
  input: { name: string; description?: string | null; department?: Department | null },
  actor: CategoryActor,
  client: DbClient = db,
): Promise<ProductCategory> {
  if (!can(actor.role, PERMISSIONS.PRODUCT_CATEGORY_CREATE)) {
    throw forbidden("You do not have permission to add categories.");
  }
  const name = validateName(input.name);
  await assertNameFree(name, null, client);

  const [row] = await client
    .insert(productCategories)
    .values({
      name,
      slug: await freeSlug(name, client),
      description: input.description?.trim() || null,
      department: input.department ?? GENERAL_DEPARTMENT,
      createdBy: actor.id,
    })
    .returning();
  await recordAudit(
    {
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.PRODUCT_CATEGORY_CREATED,
      entityType: "product_category",
      entityId: row.id,
      newValue: { name: row.name, description: row.description, department: row.department },
    },
    client,
  );
  return row;
}

/**
 * May this actor edit or remove this category? Staff: any non-system category.
 * Shop owner: one they created, while no shop owned by someone else carries it.
 */
async function assertCanManageCategory(category: ProductCategory, actor: CategoryActor, client: DbClient) {
  if (can(actor.role, PERMISSIONS.PRODUCT_CATEGORY_MANAGE_ANY)) return;
  if (!can(actor.role, PERMISSIONS.PRODUCT_CATEGORY_MANAGE_OWN)) {
    throw forbidden("You do not have permission to change categories.");
  }
  if (category.createdBy !== actor.id) {
    throw forbidden("You can only change categories you created. Ask an operator to change this one.");
  }
  const [shared] = await client
    .select({ id: shopProductCategories.id })
    .from(shopProductCategories)
    .innerJoin(shops, eq(shops.id, shopProductCategories.shopId))
    .where(
      and(
        eq(shopProductCategories.categoryId, category.id),
        ne(shops.ownerId, actor.id),
        isNull(shops.deletedAt),
      ),
    )
    .limit(1);
  if (shared) {
    throw forbidden("Other shops use this category now, so only an operator can change it.");
  }
}

export async function updateProductCategory(
  id: string,
  patch: { name?: string; description?: string | null; isActive?: boolean; department?: Department },
  actor: CategoryActor,
): Promise<ProductCategory> {
  const current = await loadLiveCategory(id);
  if (current.isSystem && (patch.name !== undefined || patch.isActive === false)) {
    throw forbidden("General is permanent: it cannot be renamed or deactivated.");
  }
  await assertCanManageCategory(current, actor, db);

  const set: Partial<typeof productCategories.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = validateName(patch.name);
    await assertNameFree(name, id, db);
    set.name = name; // the slug is a stable key and is left alone
  }
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (patch.department !== undefined) set.department = patch.department;

  const [row] = await db.update(productCategories).set(set).where(eq(productCategories.id, id)).returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PRODUCT_CATEGORY_UPDATED,
    entityType: "product_category",
    entityId: id,
    previousValue: { name: current.name, description: current.description, isActive: current.isActive, department: current.department },
    newValue: { name: row.name, description: row.description, isActive: row.isActive, department: row.department },
  });
  return row;
}

export interface CategoryRemovalImpact {
  categoryId: string;
  categoryName: string;
  /** Products that will move to General. */
  productCount: number;
  /** Shops the category will be unlinked from. */
  shopCount: number;
  /**
   * Live shop listings of those products in shops that do not carry General.
   * They pause after removal unless General is added to those shops
   * (`keepListingsVisible`, the default).
   */
  listingsAtRisk: number;
  shopsNeedingGeneral: number;
}

export async function getCategoryRemovalImpact(id: string, client: DbClient = db): Promise<CategoryRemovalImpact> {
  const category = await loadLiveCategory(id, client);
  const general = await ensureGeneralCategory(client);
  const [counts] = await client.execute<{
    product_count: number;
    shop_count: number;
    listings_at_risk: number;
    shops_needing_general: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM products p WHERE p.category_id = ${id} AND p.deleted_at IS NULL) AS product_count,
      (SELECT count(*)::int FROM shop_product_categories l JOIN shops s ON s.id = l.shop_id
         WHERE l.category_id = ${id} AND s.deleted_at IS NULL) AS shop_count,
      (SELECT count(*)::int FROM shop_products sp JOIN products p ON p.id = sp.product_id
         JOIN shops s ON s.id = sp.shop_id
         WHERE p.category_id = ${id} AND sp.deleted_at IS NULL AND s.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM shop_product_categories g
                            WHERE g.shop_id = sp.shop_id AND g.category_id = ${general.id})) AS listings_at_risk,
      (SELECT count(DISTINCT sp.shop_id)::int FROM shop_products sp JOIN products p ON p.id = sp.product_id
         JOIN shops s ON s.id = sp.shop_id
         WHERE p.category_id = ${id} AND sp.deleted_at IS NULL AND s.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM shop_product_categories g
                            WHERE g.shop_id = sp.shop_id AND g.category_id = ${general.id})) AS shops_needing_general
  `);
  return {
    categoryId: id,
    categoryName: category.name,
    productCount: counts.product_count,
    shopCount: counts.shop_count,
    listingsAtRisk: counts.listings_at_risk,
    shopsNeedingGeneral: counts.shops_needing_general,
  };
}

/**
 * Removes a category: products → General, shop links removed, category soft
 * deleted, all in one transaction. With `keepListingsVisible` (default true)
 * shops that list any of its products get General added, so nothing they sell
 * disappears from the storefront.
 */
export async function removeProductCategory(
  id: string,
  actor: CategoryActor,
  options: { keepListingsVisible?: boolean } = {},
): Promise<CategoryRemovalImpact & { movedProducts: number; unlinkedShops: number; generalAddedToShops: number }> {
  const keepListingsVisible = options.keepListingsVisible ?? true;
  return db.transaction(async (tx) => {
    const [category] = await tx
      .select()
      .from(productCategories)
      .where(and(eq(productCategories.id, id), isNull(productCategories.deletedAt)))
      .for("update");
    if (!category) throw notFound("Category");
    if (category.isSystem) throw forbidden("General is permanent and cannot be removed.");
    await assertCanManageCategory(category, actor, tx);

    const impact = await getCategoryRemovalImpact(id, tx);
    const general = await ensureGeneralCategory(tx);

    let generalAddedToShops = 0;
    if (keepListingsVisible) {
      const added = await tx.execute(sql`
        INSERT INTO shop_product_categories (shop_id, category_id, added_by)
        SELECT DISTINCT sp.shop_id, ${general.id}::uuid, ${actor.id}::uuid
          FROM shop_products sp JOIN products p ON p.id = sp.product_id
          JOIN shops s ON s.id = sp.shop_id
         WHERE p.category_id = ${id} AND sp.deleted_at IS NULL AND s.deleted_at IS NULL
        ON CONFLICT (shop_id, category_id) DO NOTHING
        RETURNING shop_id`);
      generalAddedToShops = added.length;
    }

    // Subcategories belong to the category being removed; the moved products
    // drop that link and the subcategories retire with their parent.
    const moved = await tx
      .update(products)
      .set({ categoryId: general.id, subcategoryId: null })
      .where(eq(products.categoryId, id))
      .returning({ id: products.id });
    await tx
      .update(productSubcategories)
      .set({ isActive: false, deletedAt: new Date() })
      .where(and(eq(productSubcategories.categoryId, id), isNull(productSubcategories.deletedAt)));

    const unlinked = await tx
      .delete(shopProductCategories)
      .where(eq(shopProductCategories.categoryId, id))
      .returning({ shopId: shopProductCategories.shopId });

    await tx
      .update(productCategories)
      .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(eq(productCategories.id, id));

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_CATEGORY_REMOVED,
        entityType: "product_category",
        entityId: id,
        previousValue: { name: category.name, description: category.description },
        newValue: {
          movedProductsTo: general.id,
          movedProducts: moved.length,
          unlinkedShopIds: unlinked.map((u) => u.shopId),
          generalAddedToShops,
        },
      },
      tx,
    );
    return { ...impact, movedProducts: moved.length, unlinkedShops: unlinked.length, generalAddedToShops };
  });
}

/* ------------------------------------------------- shop ↔ category links */

/** Owner of the shop, or staff with the any-shop capability. Throws otherwise. */
export async function assertCanManageShopCategories(
  shopId: string,
  actor: CategoryActor,
  client: DbClient = db,
): Promise<{ ownerId: string; name: string }> {
  const [shop] = await client
    .select({ ownerId: shops.ownerId, name: shops.name })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  if (can(actor.role, PERMISSIONS.SHOP_PRODUCT_CATEGORY_MANAGE_ANY)) return shop;
  if (shop.ownerId === actor.id && can(actor.role, PERMISSIONS.SHOP_PRODUCT_CATEGORY_MANAGE_OWN)) return shop;
  throw forbidden("This shop does not belong to you.");
}

export interface ShopCategoryLink {
  categoryId: string;
  name: string;
  isActive: boolean;
  isSystem: boolean;
  productCount: number;
  addedAt: Date;
  addedByName: string | null;
}

export async function listShopProductCategories(shopId: string, client: DbClient = db): Promise<ShopCategoryLink[]> {
  return client
    .select({
      categoryId: productCategories.id,
      name: productCategories.name,
      isActive: productCategories.isActive,
      isSystem: productCategories.isSystem,
      productCount: sql<number>`(SELECT count(*)::int FROM ${products} p
        WHERE p.category_id = ${productCategories.id} AND p.deleted_at IS NULL
          AND p.is_active AND p.approval_status = 'APPROVED')`,
      addedAt: shopProductCategories.createdAt,
      addedByName: sql<string | null>`(SELECT coalesce(${users.name}, ${users.email}) FROM ${users} WHERE ${users.id} = ${shopProductCategories.addedBy})`,
    })
    .from(shopProductCategories)
    .innerJoin(productCategories, eq(productCategories.id, shopProductCategories.categoryId))
    .where(and(eq(shopProductCategories.shopId, shopId), isNull(productCategories.deletedAt)))
    .orderBy(asc(productCategories.name));
}

export async function addCategoryToShop(
  shopId: string,
  categoryId: string,
  actor: CategoryActor,
  options: { reason?: string } = {},
  client: DbClient = db,
): Promise<{ added: boolean; categoryName: string }> {
  const shop = await assertCanManageShopCategories(shopId, actor, client);
  const category = await loadLiveCategory(categoryId, client);
  if (!category.isActive) throw validationFailed(`"${category.name}" is inactive and cannot be added to a shop.`);

  const inserted = await client
    .insert(shopProductCategories)
    .values({ shopId, categoryId, addedBy: actor.id })
    .onConflictDoNothing()
    .returning({ id: shopProductCategories.id });
  if (inserted.length) {
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_PRODUCT_CATEGORY_ADDED,
        entityType: "shop",
        entityId: shopId,
        newValue: {
          categoryId,
          categoryName: category.name,
          byOwner: shop.ownerId === actor.id,
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
      client,
    );
  }
  return { added: inserted.length > 0, categoryName: category.name };
}

/** Live listings this shop has in the category — they pause if it is removed. */
export async function countShopListingsInCategory(shopId: string, categoryId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shopProducts)
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(
      and(eq(shopProducts.shopId, shopId), eq(products.categoryId, categoryId), isNull(shopProducts.deletedAt)),
    );
  return row?.n ?? 0;
}

export async function removeCategoryFromShop(
  shopId: string,
  categoryId: string,
  actor: CategoryActor,
): Promise<{ removed: boolean; categoryName: string; pausedListings: number }> {
  const shop = await assertCanManageShopCategories(shopId, actor);
  const [category] = await db
    .select({ name: productCategories.name })
    .from(productCategories)
    .where(eq(productCategories.id, categoryId));
  if (!category) throw notFound("Category");

  const pausedListings = await countShopListingsInCategory(shopId, categoryId);
  const deleted = await db
    .delete(shopProductCategories)
    .where(and(eq(shopProductCategories.shopId, shopId), eq(shopProductCategories.categoryId, categoryId)))
    .returning({ id: shopProductCategories.id });
  if (deleted.length) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_PRODUCT_CATEGORY_REMOVED,
      entityType: "shop",
      entityId: shopId,
      newValue: { categoryId, categoryName: category.name, pausedListings, byOwner: shop.ownerId === actor.id },
    });
  }
  return { removed: deleted.length > 0, categoryName: category.name, pausedListings };
}

/* ------------------------------------------------------- product browsing */

export interface CatalogueRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  brandName: string | null;
  categoryId: string;
  categoryName: string;
  imageUrl: string | null;
}

interface BrowseOptions {
  query?: string;
  categoryId?: string;
  limit?: number;
  offset?: number;
}

async function browse(
  extra: (SQL | undefined)[],
  options: BrowseOptions,
): Promise<{ products: CatalogueRow[]; total: number }> {
  const q = options.query?.trim();
  const where = and(
    isNull(products.deletedAt),
    eq(products.isActive, true),
    eq(products.approvalStatus, "APPROVED"),
    isNull(productCategories.deletedAt),
    options.categoryId ? eq(products.categoryId, options.categoryId) : undefined,
    q ? or(ilike(products.name, `%${q}%`), ilike(products.code, `%${q}%`), ilike(brands.name, `%${q}%`)) : undefined,
    ...extra,
  );
  const base = () =>
    db
      .select({
        id: products.id,
        code: products.code,
        name: products.name,
        description: products.description,
        unit: products.unit,
        brandName: brands.name,
        categoryId: productCategories.id,
        categoryName: productCategories.name,
        imageUrl: products.imageUrl,
      })
      .from(products)
      .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
      .leftJoin(brands, eq(brands.id, products.brandId));
  const [rows, [count]] = await Promise.all([
    base()
      .where(where)
      .orderBy(asc(productCategories.name), asc(products.name))
      .limit(Math.min(options.limit ?? 50, 200))
      .offset(options.offset ?? 0),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(products)
      .innerJoin(productCategories, eq(productCategories.id, products.categoryId))
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(where),
  ]);
  return { products: rows, total: count?.n ?? 0 };
}

/** The whole catalogue, searchable and filterable by category (Product Master view). */
export function browseCatalogue(options: BrowseOptions = {}) {
  return browse([], options);
}

/** Exactly the products in the categories this shop carries. */
export function listProductsVisibleToShop(
  shopId: string,
  options: BrowseOptions & { excludeListed?: boolean } = {},
) {
  return browse(
    [
      shopCarriesProductCategory(shopId, products.categoryId),
      options.excludeListed
        ? sql`NOT EXISTS (SELECT 1 FROM ${shopProducts} sp WHERE sp.shop_id = ${shopId}
            AND sp.product_id = ${products.id} AND sp.deleted_at IS NULL)`
        : undefined,
    ],
    options,
  );
}

/** Ids of the shop's categories — for quick membership checks. */
export async function shopCategoryIds(shopId: string, client: DbClient = db): Promise<Set<string>> {
  const rows = await client
    .select({ categoryId: shopProductCategories.categoryId })
    .from(shopProductCategories)
    .where(eq(shopProductCategories.shopId, shopId));
  return new Set(rows.map((r) => r.categoryId));
}

/** Categories that may be chosen for a product or a shop (live and active). */
export async function listSelectableCategories(client: DbClient = db): Promise<{ id: string; name: string; isSystem: boolean }[]> {
  await ensureGeneralCategory(client);
  return client
    .select({ id: productCategories.id, name: productCategories.name, isSystem: productCategories.isSystem })
    .from(productCategories)
    .where(and(isNull(productCategories.deletedAt), eq(productCategories.isActive, true)))
    .orderBy(sql`${productCategories.isSystem} DESC`, asc(productCategories.name));
}

/** For admin lists: the categories each shop carries. */
export async function getProductCategoriesForShops(shopIds: readonly string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!shopIds.length) return map;
  const rows = await db
    .select({ shopId: shopProductCategories.shopId, name: productCategories.name })
    .from(shopProductCategories)
    .innerJoin(productCategories, eq(productCategories.id, shopProductCategories.categoryId))
    .where(and(inArray(shopProductCategories.shopId, [...shopIds]), isNull(productCategories.deletedAt)))
    .orderBy(asc(productCategories.name));
  for (const r of rows) map.set(r.shopId, [...(map.get(r.shopId) ?? []), r.name]);
  return map;
}

/* ---------------------------------------------------- product's category */

/**
 * Moves a product to another category (the product edit form). Staff may move
 * any product. A shop owner may move only a product they created that is still
 * awaiting approval — an approved product is shared by every shop.
 *
 * With `keepListingsVisible` (default true) shops that list the product start
 * carrying the new category, so the move never pauses a listing.
 */
export async function setProductCategory(
  productId: string,
  categoryId: string,
  actor: CategoryActor,
  options: { keepListingsVisible?: boolean } = {},
): Promise<{ productId: string; categoryId: string; categoryName: string; shopsLinked: number }> {
  return db.transaction(async (tx) => {
    const [product] = await tx
      .select({
        id: products.id,
        name: products.name,
        categoryId: products.categoryId,
        createdBy: products.createdBy,
        approvalStatus: products.approvalStatus,
      })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)))
      .for("update");
    if (!product) throw notFound("Product");

    const staff = can(actor.role, PERMISSIONS.PRODUCT_MANAGE);
    if (!staff && !(product.createdBy === actor.id && product.approvalStatus === "PENDING_APPROVAL")) {
      throw forbidden("Only an operator can change the category of a published product.");
    }
    const category = await loadLiveCategory(categoryId, tx);
    if (!category.isActive) throw validationFailed(`"${category.name}" is inactive — choose another category.`);
    if (product.categoryId === categoryId) {
      return { productId, categoryId, categoryName: category.name, shopsLinked: 0 };
    }

    let shopsLinked = 0;
    if (options.keepListingsVisible ?? true) {
      const linked = await tx.execute(sql`
        INSERT INTO shop_product_categories (shop_id, category_id, added_by)
        SELECT DISTINCT sp.shop_id, ${categoryId}::uuid, ${actor.id}::uuid
          FROM shop_products sp JOIN shops s ON s.id = sp.shop_id
         WHERE sp.product_id = ${productId} AND sp.deleted_at IS NULL AND s.deleted_at IS NULL
           ${staff ? sql`` : sql`AND s.owner_id = ${actor.id}`}
        ON CONFLICT (shop_id, category_id) DO NOTHING
        RETURNING shop_id`);
      shopsLinked = linked.length;
    }

    // A subcategory belongs to the old category, so it does not follow the product.
    await tx.update(products).set({ categoryId, subcategoryId: null }).where(eq(products.id, productId));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRODUCT_CATEGORY_CHANGED,
        entityType: "product",
        entityId: productId,
        previousValue: { categoryId: product.categoryId },
        newValue: { categoryId, categoryName: category.name, shopsLinked },
      },
      tx,
    );
    return { productId, categoryId, categoryName: category.name, shopsLinked };
  });
}
