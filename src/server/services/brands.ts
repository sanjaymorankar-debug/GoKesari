/**
 * Brand master (Product Master brief §2, §3).
 *
 * Deliberately admin/operator-managed, not shop-owner-editable: a brand is
 * shared across every shop selling that product, so letting one shop rename
 * "Amul" would rewrite it for everyone. Shops pick an existing brand when
 * creating a product; they never mint one.
 */
import { and, asc, eq, ilike, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { likePattern } from "@/lib/like-pattern";
import { db } from "@/server/db";
import { brands, type Brand, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";

interface Actor {
  id: string;
  role: UserRole;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function listBrands(options: { query?: string; limit?: number } = {}): Promise<Brand[]> {
  const conditions = [isNull(brands.deletedAt)];
  if (options.query?.trim()) {
    conditions.push(ilike(brands.name, `%${options.query.trim()}%`));
  }
  return db
    .select()
    .from(brands)
    .where(and(...conditions))
    .orderBy(asc(brands.name))
    .limit(options.limit ?? 500);
}

export async function createBrand(
  input: { name: string; description?: string | null; logoUrl?: string | null },
  actor: Actor,
): Promise<Brand> {
  const name = input.name.trim();
  if (!name) throw validationFailed("Enter a brand name.");
  const slug = slugify(name);
  if (!slug) throw validationFailed("Brand name must contain at least one letter or number.");

  const existing = await db.query.brands.findFirst({ where: eq(brands.slug, slug) });
  if (existing) throw conflict(`A brand named "${existing.name}" already exists.`);

  const [brand] = await db
    .insert(brands)
    .values({
      name,
      slug,
      description: input.description?.trim() || null,
      logoUrl: input.logoUrl?.trim() || null,
      createdBy: actor.id,
    })
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BRAND_CREATED,
    entityType: "brand",
    entityId: brand.id,
    newValue: { name, slug },
  });

  return brand;
}

export async function updateBrand(
  id: string,
  patch: { name?: string; description?: string | null; logoUrl?: string | null; isActive?: boolean },
  actor: Actor,
): Promise<Brand> {
  const current = await db.query.brands.findFirst({
    where: and(eq(brands.id, id), isNull(brands.deletedAt)),
  });
  if (!current) throw notFound("Brand");

  // The slug is intentionally left alone on rename: it may already be
  // embedded in URLs, and a brand's identity shouldn't shift under them.
  const [updated] = await db
    .update(brands)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.logoUrl !== undefined ? { logoUrl: patch.logoUrl } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(brands.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BRAND_UPDATED,
    entityType: "brand",
    entityId: id,
    previousValue: { name: current.name, isActive: current.isActive },
    newValue: { name: updated.name, isActive: updated.isActive },
  });

  return updated;
}

/* ---------------------------------------------- customer side (docs/search-brand-barcode-favourites-2026-11)
 * Read-only. Callers check the flag brand_barcode_favourites_enabled first. */

export interface PublicBrand {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
}

const publicBrandColumns = {
  id: brands.id,
  name: brands.name,
  slug: brands.slug,
  description: brands.description,
  logoUrl: brands.logoUrl,
};

/** An active brand by its slug (the /brand/[slug] page and the ?brand= filter on /search), or null. */
export async function getPublicBrandBySlug(slug: string): Promise<PublicBrand | null> {
  const clean = slug.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,120}$/.test(clean)) return null;
  const [row] = await db
    .select(publicBrandColumns)
    .from(brands)
    .where(and(eq(brands.slug, clean), eq(brands.isActive, true), isNull(brands.deletedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * Active brands whose name contains what was typed, with at least one active approved product,
 * names starting with it first. For the search box's "Brands" group and the brand chips on /search.
 */
export async function searchPublicBrands(rawQuery: string, limit = 3): Promise<(PublicBrand & { productCount: number })[]> {
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, 60);
  if (query.length < 2) return [];
  const lower = query.toLowerCase();
  const productCount = sql<number>`(SELECT count(*)::int FROM products p WHERE p.brand_id = "brands"."id" AND p.is_active AND p.deleted_at IS NULL AND p.approval_status = 'APPROVED')`;
  const rows = await db
    .select({ ...publicBrandColumns, productCount })
    .from(brands)
    .where(and(eq(brands.isActive, true), isNull(brands.deletedAt), ilike(brands.name, likePattern(query)), sql`${productCount} > 0`))
    .orderBy(asc(sql`position(${lower} in lower(${brands.name}))`), asc(sql`length(${brands.name})`), asc(brands.name))
    .limit(Math.min(Math.max(limit, 1), 10));
  return rows.map((r) => ({ ...r, productCount: Number(r.productCount) }));
}
