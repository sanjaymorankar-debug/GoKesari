/**
 * Brand master (Product Master brief §2, §3).
 *
 * Deliberately admin/operator-managed, not shop-owner-editable: a brand is
 * shared across every shop selling that product, so letting one shop rename
 * "Amul" would rewrite it for everyone. Shops pick an existing brand when
 * creating a product; they never mint one.
 */
import { and, asc, eq, ilike, isNull } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
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
