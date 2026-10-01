/**
 * Shop categories (many per shop). See the note on the table in schema.ts for
 * how they differ from shop type, product categories and Kesari/Green.
 *
 * Owners choose categories for their own shop; operators and admins manage the
 * category list and can assign categories to any shop. Changing a shop's
 * categories only touches the mapping rows — products, stock, carts and orders
 * are never affected.
 */
import { and, asc, eq, ilike, inArray, isNull, notExists, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  shopCategories,
  shopCategoryMapping,
  shops,
  type ShopCategory,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

interface Actor {
  id: string;
  role: UserRole;
}

const isStaff = (role: UserRole) => role === "OPERATOR" || role === "ADMIN";
export const CATEGORY_REQUIRED_MESSAGE = "Please select at least one shop category.";

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/* --------------------------------------------------------- category list */

export async function listShopCategories(
  options: { activeOnly?: boolean; query?: string } = {},
  client: DbClient = db,
): Promise<(ShopCategory & { shopCount: number })[]> {
  const conditions = [
    options.activeOnly ? eq(shopCategories.status, "ACTIVE") : undefined,
    options.query?.trim() ? ilike(shopCategories.name, `%${options.query.trim()}%`) : undefined,
  ].filter(Boolean);
  return client
    .select({
      id: shopCategories.id,
      name: shopCategories.name,
      slug: shopCategories.slug,
      description: shopCategories.description,
      status: shopCategories.status,
      createdAt: shopCategories.createdAt,
      updatedAt: shopCategories.updatedAt,
      shopCount: sql<number>`(select count(*)::int from ${shopCategoryMapping} m join ${shops} s on s.id = m.shop_id
        where m.category_id = shop_categories.id and s.deleted_at is null)`,
    })
    .from(shopCategories)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(shopCategories.name));
}

export async function createShopCategory(
  input: { name: string; description?: string | null },
  actor: Actor,
): Promise<ShopCategory> {
  if (!isStaff(actor.role)) throw forbidden("Only operations can manage shop categories.");
  const name = input.name.trim();
  if (name.length < 2 || name.length > 80) throw validationFailed("A category name needs 2–80 characters.");
  const slug = slugify(name);
  if (!slug) throw validationFailed("Use letters or numbers in the category name.");
  const [clash] = await db
    .select({ id: shopCategories.id })
    .from(shopCategories)
    .where(sql`lower(${shopCategories.name}) = ${name.toLowerCase()} OR ${shopCategories.slug} = ${slug}`);
  if (clash) throw conflict("A shop category with that name already exists.");

  const [row] = await db
    .insert(shopCategories)
    .values({ name, slug, description: input.description?.trim() || null })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_CATEGORY_SAVED,
    entityType: "shop_category",
    entityId: row.id,
    newValue: { name, status: row.status },
  });
  return row;
}

/** Rename, describe, or activate/deactivate. A deactivated category stays on the shops that have it but cannot be newly chosen. */
export async function updateShopCategory(
  id: string,
  patch: { name?: string; description?: string | null; status?: "ACTIVE" | "INACTIVE" },
  actor: Actor,
): Promise<ShopCategory> {
  if (!isStaff(actor.role)) throw forbidden("Only operations can manage shop categories.");
  const [current] = await db.select().from(shopCategories).where(eq(shopCategories.id, id));
  if (!current) throw notFound("Shop category");

  const set: Partial<typeof shopCategories.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length < 2 || name.length > 80) throw validationFailed("A category name needs 2–80 characters.");
    const [clash] = await db
      .select({ id: shopCategories.id })
      .from(shopCategories)
      .where(and(sql`lower(${shopCategories.name}) = ${name.toLowerCase()}`, sql`${shopCategories.id} <> ${id}`));
    if (clash) throw conflict("A shop category with that name already exists.");
    // The slug is a stable key and is left alone when renaming.
    set.name = name;
  }
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.status !== undefined) set.status = patch.status;

  const [row] = await db.update(shopCategories).set(set).where(eq(shopCategories.id, id)).returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_CATEGORY_SAVED,
    entityType: "shop_category",
    entityId: id,
    previousValue: { name: current.name, status: current.status, description: current.description },
    newValue: { name: row.name, status: row.status, description: row.description },
  });
  return row;
}

/* ------------------------------------------------------ a shop's categories */

export async function getShopCategories(shopId: string, client: DbClient = db): Promise<ShopCategory[]> {
  const rows = await client
    .select({ category: shopCategories })
    .from(shopCategoryMapping)
    .innerJoin(shopCategories, eq(shopCategoryMapping.categoryId, shopCategories.id))
    .where(eq(shopCategoryMapping.shopId, shopId))
    .orderBy(asc(shopCategories.name));
  return rows.map((r) => r.category);
}

/** Categories for many shops at once (lists, admin views). */
export async function getCategoriesForShops(shopIds: readonly string[]): Promise<Map<string, ShopCategory[]>> {
  const map = new Map<string, ShopCategory[]>();
  if (shopIds.length === 0) return map;
  const rows = await db
    .select({ shopId: shopCategoryMapping.shopId, category: shopCategories })
    .from(shopCategoryMapping)
    .innerJoin(shopCategories, eq(shopCategoryMapping.categoryId, shopCategories.id))
    .where(inArray(shopCategoryMapping.shopId, [...shopIds]))
    .orderBy(asc(shopCategories.name));
  for (const r of rows) map.set(r.shopId, [...(map.get(r.shopId) ?? []), r.category]);
  return map;
}

/**
 * Makes a shop's categories exactly `categoryIds`. Newly added categories must
 * be active; categories the shop already has may stay even if since deactivated.
 * Runs on the caller's transaction when given one (registration uses this).
 */
export async function applyShopCategories(
  client: DbClient,
  shopId: string,
  categoryIds: readonly string[],
  options: { requireAtLeastOne?: boolean } = { requireAtLeastOne: true },
): Promise<{ added: string[]; removed: string[] }> {
  const wanted = [...new Set(categoryIds)];
  if (options.requireAtLeastOne !== false && wanted.length === 0) throw validationFailed(CATEGORY_REQUIRED_MESSAGE);

  const found = wanted.length
    ? await client.select().from(shopCategories).where(inArray(shopCategories.id, wanted))
    : [];
  if (found.length !== wanted.length) throw validationFailed("One of those categories does not exist.");

  const existing = await client
    .select({ categoryId: shopCategoryMapping.categoryId })
    .from(shopCategoryMapping)
    .where(eq(shopCategoryMapping.shopId, shopId));
  const have = new Set(existing.map((e) => e.categoryId));
  const added = wanted.filter((id) => !have.has(id));
  const removed = [...have].filter((id) => !wanted.includes(id));

  const inactiveNew = found.filter((c) => added.includes(c.id) && c.status !== "ACTIVE");
  if (inactiveNew.length) {
    throw validationFailed(`"${inactiveNew[0].name}" is no longer available to choose.`);
  }
  if (removed.length) {
    await client
      .delete(shopCategoryMapping)
      .where(and(eq(shopCategoryMapping.shopId, shopId), inArray(shopCategoryMapping.categoryId, removed)));
  }
  if (added.length) {
    await client
      .insert(shopCategoryMapping)
      .values(added.map((categoryId) => ({ shopId, categoryId })))
      .onConflictDoNothing();
  }
  return { added, removed };
}

/** Owner edits their shop's categories; staff may edit any shop's. */
export async function setShopCategories(
  shopId: string,
  categoryIds: readonly string[],
  actor: Actor,
): Promise<ShopCategory[]> {
  const [shop] = await db
    .select({ ownerId: shops.ownerId })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId !== actor.id && !isStaff(actor.role)) throw forbidden("This shop does not belong to you.");

  const change = await db.transaction((tx) => applyShopCategories(tx, shopId, categoryIds));
  if (change.added.length || change.removed.length) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_CATEGORIES_CHANGED,
      entityType: "shop",
      entityId: shopId,
      newValue: { added: change.added, removed: change.removed, byOwner: shop.ownerId === actor.id },
    });
  }
  return getShopCategories(shopId);
}

/* ------------------------------------------------------------- reporting */

export async function listShopsInCategory(categoryId: string) {
  return db
    .select({ id: shops.id, name: shops.name, city: shops.city, status: shops.status, ownerName: shops.ownerName })
    .from(shopCategoryMapping)
    .innerJoin(shops, eq(shopCategoryMapping.shopId, shops.id))
    .where(and(eq(shopCategoryMapping.categoryId, categoryId), isNull(shops.deletedAt)))
    .orderBy(asc(shops.name));
}

/** Live shops with no category — flagged for the owner and for operations to complete. */
export async function listUncategorisedShops(limit = 200) {
  return db
    .select({ id: shops.id, name: shops.name, city: shops.city, status: shops.status, ownerName: shops.ownerName })
    .from(shops)
    .where(
      and(
        isNull(shops.deletedAt),
        notExists(db.select({ x: sql`1` }).from(shopCategoryMapping).where(eq(shopCategoryMapping.shopId, shops.id))),
      ),
    )
    .orderBy(asc(shops.name))
    .limit(limit);
}
