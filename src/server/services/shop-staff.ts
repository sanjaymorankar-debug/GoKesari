/**
 * Shop staff (Module 1, docs/three-modules-2026-10): people a shop owner lets
 * edit the shop's product photos and descriptions, and the one access check
 * every photo/description route uses.
 *
 * Who may edit a shop's product photos and descriptions:
 *   OWNER    the shop's owner;
 *   STAFF    an ACTIVE shop_staff row for this shop (scope CATALOGUE) — the
 *            person keeps their own account and role, and gets nothing else;
 *   SUPPORT  operators and administrators (SHOP_PRODUCT_MANAGE_ANY), for
 *            support. Every change is audited with who acted and as what.
 * Anyone else, including another shop's owner or staff, is refused.
 *
 * `requireShopAccess` (authz/guards.ts) is deliberately left as it is — staff
 * get access through this module's routes only.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { maskEmail, maskPhone, parsePhone } from "@/lib/phone";
import { requireUser, type AuthenticatedUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import { shopProducts, shopStaff, shops, users, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";

export type CatalogueAccessVia = "OWNER" | "STAFF" | "SUPPORT";

export interface CatalogueActor {
  id: string;
  role: UserRole;
  via: CatalogueAccessVia;
}

interface ActorLike {
  id: string;
  role: UserRole;
}

/** How `actor` may edit this shop's product content, or null when they may not. */
export async function catalogueAccessFor(
  shopId: string,
  actor: ActorLike,
  client: DbClient = db,
): Promise<CatalogueAccessVia | null> {
  const [shop] = await client
    .select({ ownerId: shops.ownerId })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) return null;
  if (shop.ownerId === actor.id) return "OWNER";
  const [staff] = await client
    .select({ id: shopStaff.id })
    .from(shopStaff)
    .where(
      and(
        eq(shopStaff.shopId, shopId),
        eq(shopStaff.userId, actor.id),
        eq(shopStaff.status, "ACTIVE"),
        eq(shopStaff.scope, "CATALOGUE"),
      ),
    );
  if (staff) return "STAFF";
  if (can(actor.role, PERMISSIONS.SHOP_PRODUCT_MANAGE_ANY)) return "SUPPORT";
  return null;
}

/** The signed-in user, if they may edit this shop's product photos and descriptions. */
export async function requireShopCatalogueAccess(shopId: string): Promise<CatalogueActor> {
  const user = await requireUser();
  return assertShopCatalogueAccess(shopId, user);
}

export async function assertShopCatalogueAccess(shopId: string, actor: ActorLike): Promise<CatalogueActor> {
  const [shop] = await db.select({ id: shops.id }).from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const via = await catalogueAccessFor(shopId, actor);
  if (!via) throw forbidden("You cannot edit this shop's products.");
  return { id: actor.id, role: actor.role, via };
}

/** The listing, checked to belong to the shop (a listing of another shop is "not found"). */
export async function loadShopListing(shopId: string, listingId: string, client: DbClient = db) {
  const [row] = await client
    .select()
    .from(shopProducts)
    .where(and(eq(shopProducts.id, listingId), eq(shopProducts.shopId, shopId), isNull(shopProducts.deletedAt)));
  if (!row) throw notFound("Product in this shop");
  return row;
}

/* ------------------------------------------------------- managing staff */

export interface StaffMember {
  id: string;
  userId: string;
  name: string | null;
  contact: string;
  status: "ACTIVE" | "REVOKED";
  addedAt: Date;
  revokedAt: Date | null;
}

/** The owner (or an operator/admin) of the shop; staff cannot manage staff. */
async function requireStaffManager(shopId: string, actor: AuthenticatedUser | ActorLike) {
  const [shop] = await db
    .select({ id: shops.id, name: shops.name, ownerId: shops.ownerId })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const isOwner = shop.ownerId === actor.id && can(actor.role, PERMISSIONS.SHOP_STAFF_MANAGE_OWN);
  if (!isOwner && !can(actor.role, PERMISSIONS.SHOP_UPDATE_ANY)) {
    throw forbidden("Only the shop's owner can choose who edits its products.");
  }
  return shop;
}

export async function listShopStaff(shopId: string, actor: ActorLike): Promise<StaffMember[]> {
  await requireStaffManager(shopId, actor);
  const rows = await db
    .select({
      id: shopStaff.id,
      userId: shopStaff.userId,
      status: shopStaff.status,
      addedAt: shopStaff.addedAt,
      revokedAt: shopStaff.revokedAt,
      name: users.name,
      email: users.email,
      phoneE164: users.phoneE164,
    })
    .from(shopStaff)
    .innerJoin(users, eq(users.id, shopStaff.userId))
    .where(eq(shopStaff.shopId, shopId))
    .orderBy(desc(shopStaff.addedAt));
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    name: r.name,
    contact: r.phoneE164 ? maskPhone(r.phoneE164) : maskEmail(r.email),
    status: r.status,
    addedAt: r.addedAt,
    revokedAt: r.revokedAt,
  }));
}

/** Finds the account for a 10-digit Indian mobile number or an email address. */
async function findAccount(identifier: string) {
  const raw = identifier.trim();
  if (raw.includes("@")) {
    const [row] = await db
      .select({ id: users.id, name: users.name, status: users.status })
      .from(users)
      .where(and(eq(users.email, raw.toLowerCase()), isNull(users.deletedAt)));
    return row ?? null;
  }
  const parsed = parsePhone("+91", raw.replace(/^\+91/, ""));
  if (!parsed.ok) throw validationFailed("Enter the person's 10-digit mobile number or their email address.");
  const [row] = await db
    .select({ id: users.id, name: users.name, status: users.status })
    .from(users)
    .where(and(eq(users.phoneE164, parsed.e164), isNull(users.deletedAt)));
  return row ?? null;
}

export async function addShopStaff(shopId: string, identifier: string, actor: ActorLike): Promise<StaffMember> {
  const shop = await requireStaffManager(shopId, actor);
  const account = await findAccount(identifier);
  if (!account || account.status !== "ACTIVE") {
    throw validationFailed("No active GoKesari account uses that mobile number or email. Ask them to sign in once, then add them.");
  }
  if (account.id === shop.ownerId) throw conflict("The shop's owner can already edit its products.");

  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: shopStaff.id })
      .from(shopStaff)
      .where(and(eq(shopStaff.shopId, shopId), eq(shopStaff.userId, account.id), eq(shopStaff.status, "ACTIVE")));
    if (existing) throw conflict("This person can already edit this shop's products.");
    const [created] = await tx
      .insert(shopStaff)
      .values({ shopId, userId: account.id, scope: "CATALOGUE", addedBy: actor.id })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_STAFF_ADDED,
        entityType: "shop",
        entityId: shopId,
        newValue: { staffId: created.id, userId: account.id, scope: "CATALOGUE" },
      },
      tx,
    );
    const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.id));
    await notify(
      {
        userId: account.id,
        type: NOTIFICATION_TYPES.SHOP_STAFF_ADDED,
        vars: { ownerName: owner?.name ?? "The shop owner", shopName: shop.name },
        actionUrl: "/shop/staff-access",
        dedupeKey: `shop-staff-added:${created.id}`,
      },
      tx,
    );
    return created;
  });
  const [member] = (await listShopStaff(shopId, actor)).filter((m) => m.id === row.id);
  return member;
}

export async function removeShopStaff(shopId: string, staffId: string, actor: ActorLike): Promise<void> {
  const shop = await requireStaffManager(shopId, actor);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(shopStaff)
      .set({ status: "REVOKED", revokedBy: actor.id, revokedAt: new Date() })
      .where(and(eq(shopStaff.id, staffId), eq(shopStaff.shopId, shopId), eq(shopStaff.status, "ACTIVE")))
      .returning();
    if (!row) throw notFound("Staff member");
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_STAFF_REMOVED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { staffId: row.id, userId: row.userId, status: "ACTIVE" },
        newValue: { status: "REVOKED" },
      },
      tx,
    );
    await notify(
      {
        userId: row.userId,
        type: NOTIFICATION_TYPES.SHOP_STAFF_REMOVED,
        vars: { shopName: shop.name },
        dedupeKey: `shop-staff-removed:${row.id}`,
      },
      tx,
    );
  });
}

/** Shops the user is active staff of — their way in (/shop/staff-access). */
export async function listShopsWhereStaff(userId: string) {
  return db
    .select({ shopId: shops.id, shopName: shops.name, slug: shops.slug, addedAt: shopStaff.addedAt })
    .from(shopStaff)
    .innerJoin(shops, eq(shops.id, shopStaff.shopId))
    .where(and(eq(shopStaff.userId, userId), eq(shopStaff.status, "ACTIVE"), isNull(shops.deletedAt)))
    .orderBy(shops.name);
}
