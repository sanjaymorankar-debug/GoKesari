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
 *
 * Module 10 (docs/shop-staff-roles-2026-11, flag shop_staff_roles_enabled):
 * a staff row carries a role (and extra permissions); every existing row is
 * CATALOGUE_MANAGER, which is exactly the photo/description access above.
 * Catalogue access is "an ACTIVE row whose role grants catalogue.edit" — for
 * every row that existed before, the same answer as before. With the flag on,
 * owners invite people with a role, change roles, pause and restore access;
 * other shop routes check permissions through requireShopPermission
 * (authz/shop-permission.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { maskEmail, maskPhone, parsePhone } from "@/lib/phone";
import {
  canGrant,
  effectivePermissions,
  isShopStaffRole,
  LEGACY_CATALOGUE_ROLE,
  normalisePermissions,
  permissionAllows,
  roleAllows,
  SHOP_STAFF_ROLE_LABELS,
  type ShopStaffPermission,
  type ShopStaffRole,
} from "@/lib/shop-staff/permissions";
import { requireUser, type AuthenticatedUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import { auditLogs, orders, shopProducts, shopStaff, shops, users, type UserRole } from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { featureNotAvailable } from "./feature-flags";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { activeStaffGrant, SHOP_STAFF_ROLES_FLAG, shopStaffRolesEnabled } from "./shop-staff-access";

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
    .select({ id: shopStaff.id, role: shopStaff.role, permissions: shopStaff.permissions })
    .from(shopStaff)
    .where(
      and(
        eq(shopStaff.shopId, shopId),
        eq(shopStaff.userId, actor.id),
        eq(shopStaff.status, "ACTIVE"),
        eq(shopStaff.scope, "CATALOGUE"),
      ),
    );
  // Module 10: the role must grant catalogue.edit — true for every pre-Module-10 row (CATALOGUE_MANAGER).
  if (staff && roleAllows(staff.role, staff.permissions, "catalogue.edit")) return "STAFF";
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

export type StaffStatus = "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";

export interface StaffMember {
  id: string;
  userId: string | null;
  name: string | null;
  contact: string;
  status: StaffStatus;
  addedAt: Date;
  revokedAt: Date | null;
  /** Module 10 (shown only with shop_staff_roles_enabled on). */
  role: ShopStaffRole;
  /** Extra grants (or the whole list for CUSTOM). */
  permissions: ShopStaffPermission[];
  /** What the role and extra grants allow together. */
  effective: ShopStaffPermission[];
  inviteExpiresAt: Date | null;
  acceptedAt: Date | null;
  suspendedAt: Date | null;
}

interface StaffManagerContext {
  shop: { id: string; name: string; ownerId: string };
  /** null: the owner or operations (may grant anything); else the managing staff member's own permissions. */
  granter: ShopStaffPermission[] | null;
  /** The managing staff member's own row, when a staff member manages. */
  granterStaffId: string | null;
}

/**
 * The owner (or an operator/admin) of the shop; with shop_staff_roles_enabled
 * on, also an active staff member holding `staffPermission` (a manager), who
 * may only give what they hold and never touch a MANAGER (canGrant).
 */
async function requireStaffManager(
  shopId: string,
  actor: AuthenticatedUser | ActorLike,
  staffPermission: ShopStaffPermission = "staff.edit",
): Promise<StaffManagerContext> {
  const [shop] = await db
    .select({ id: shops.id, name: shops.name, ownerId: shops.ownerId })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  const isOwner = shop.ownerId === actor.id && can(actor.role, PERMISSIONS.SHOP_STAFF_MANAGE_OWN);
  if (isOwner || can(actor.role, PERMISSIONS.SHOP_UPDATE_ANY)) return { shop, granter: null, granterStaffId: null };
  if (await shopStaffRolesEnabled()) {
    const grant = await activeStaffGrant(shopId, actor.id);
    if (grant && permissionAllows(grant.permissions, staffPermission)) {
      return { shop, granter: grant.permissions, granterStaffId: grant.staffId };
    }
  }
  throw forbidden("Only the shop's owner can choose who edits its products.");
}

export async function listShopStaff(shopId: string, actor: ActorLike): Promise<StaffMember[]> {
  await requireStaffManager(shopId, actor, "staff.view");
  const rows = await db
    .select({
      id: shopStaff.id,
      userId: shopStaff.userId,
      status: shopStaff.status,
      addedAt: shopStaff.addedAt,
      revokedAt: shopStaff.revokedAt,
      role: shopStaff.role,
      permissions: shopStaff.permissions,
      inviteEmail: shopStaff.inviteEmail,
      inviteExpiresAt: shopStaff.inviteExpiresAt,
      acceptedAt: shopStaff.acceptedAt,
      suspendedAt: shopStaff.suspendedAt,
      name: users.name,
      email: users.email,
      phoneE164: users.phoneE164,
    })
    .from(shopStaff)
    .leftJoin(users, eq(users.id, shopStaff.userId))
    .where(eq(shopStaff.shopId, shopId))
    .orderBy(desc(shopStaff.addedAt));
  return rows.map((r) => {
    const role = isShopStaffRole(r.role) ? r.role : LEGACY_CATALOGUE_ROLE;
    return {
      id: r.id,
      userId: r.userId,
      name: r.name,
      contact: r.phoneE164 ? maskPhone(r.phoneE164) : r.email ? maskEmail(r.email) : r.inviteEmail ? maskEmail(r.inviteEmail) : "—",
      status: r.status,
      addedAt: r.addedAt,
      revokedAt: r.revokedAt,
      role,
      permissions: normalisePermissions(r.permissions),
      effective: effectivePermissions(role, r.permissions),
      inviteExpiresAt: r.inviteExpiresAt,
      acceptedAt: r.acceptedAt,
      suspendedAt: r.suspendedAt,
    };
  });
}

/** Finds the account for a 10-digit Indian mobile number or an email address. */
async function findAccount(identifier: string) {
  const raw = identifier.trim();
  if (raw.includes("@")) {
    const [row] = await db
      .select({ id: users.id, name: users.name, status: users.status, email: users.email })
      .from(users)
      .where(and(eq(users.email, raw.toLowerCase()), isNull(users.deletedAt)));
    return row ?? null;
  }
  const parsed = parsePhone("+91", raw.replace(/^\+91/, ""));
  if (!parsed.ok) throw validationFailed("Enter the person's 10-digit mobile number or their email address.");
  const [row] = await db
    .select({ id: users.id, name: users.name, status: users.status, email: users.email })
    .from(users)
    .where(and(eq(users.phoneE164, parsed.e164), isNull(users.deletedAt)));
  return row ?? null;
}

/** Module 1 (flag off): adds an existing account as catalogue staff at once. */
export async function addShopStaff(shopId: string, identifier: string, actor: ActorLike): Promise<StaffMember> {
  const { shop, granter } = await requireStaffManager(shopId, actor, "staff.create");
  if (!canGrant(granter, LEGACY_CATALOGUE_ROLE, [])) throw forbidden("You can only give permissions you have yourself.");
  const account = await findAccount(identifier);
  if (!account || account.status !== "ACTIVE") {
    throw validationFailed("No active GoKesari account uses that mobile number or email. Ask them to sign in once, then add them.");
  }
  if (account.id === shop.ownerId) throw conflict("The shop's owner can already edit its products.");

  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: shopStaff.id })
      .from(shopStaff)
      .where(and(eq(shopStaff.shopId, shopId), eq(shopStaff.userId, account.id), inArray(shopStaff.status, OPEN_STATUSES)));
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

const OPEN_STATUSES: StaffStatus[] = ["INVITED", "ACTIVE", "SUSPENDED"];

/** How long an invitation link works. */
export const INVITE_TTL_DAYS = 7;

export const hashInviteToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

function siteUrl(path: string): string {
  const base = (getEnv().AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
  return `${base}${path}`;
}

export interface InviteInput {
  identifier: string;
  role: ShopStaffRole;
  permissions?: readonly string[];
}

function checkRoleInput(role: ShopStaffRole, permissions: readonly string[] | undefined): ShopStaffPermission[] {
  if (!isShopStaffRole(role)) throw validationFailed("Choose a role.");
  const extra = normalisePermissions(permissions ?? []);
  if (role === "CUSTOM" && extra.length === 0) throw validationFailed("A custom role needs at least one permission.");
  return extra;
}

async function requireRolesFlag(): Promise<void> {
  if (!(await shopStaffRolesEnabled())) throw featureNotAvailable(SHOP_STAFF_ROLES_FLAG);
}

/**
 * Module 10: invite a person with a role. An existing account gets an in-app
 * notification (and e-mail by its preferences) and accepts on
 * /shop/staff-access; an e-mail address with no account gets an e-mail with a
 * one-time link — they sign in with the normal e-mailed code and accept.
 * Nothing is granted until they accept (status INVITED).
 */
export async function inviteShopStaff(shopId: string, input: InviteInput, actor: ActorLike): Promise<StaffMember> {
  await requireRolesFlag();
  const { shop, granter } = await requireStaffManager(shopId, actor, "staff.create");
  const extra = checkRoleInput(input.role, input.permissions);
  if (!canGrant(granter, input.role, extra)) {
    throw forbidden("You can only give permissions you have yourself, and only the owner can add a manager.");
  }
  const raw = input.identifier.trim();
  const account = await findAccount(raw);
  if (account && account.status !== "ACTIVE") throw validationFailed("That GoKesari account is not active.");
  if (!account && !raw.includes("@")) {
    throw validationFailed("No GoKesari account uses that mobile number. Invite them by e-mail instead — we cannot send text messages yet.");
  }
  if (account?.id === shop.ownerId) throw conflict("The shop's owner already has every permission.");
  const inviteEmail = account ? null : raw.toLowerCase();

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60_000);
  const created = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: shopStaff.id })
      .from(shopStaff)
      .where(
        and(
          eq(shopStaff.shopId, shopId),
          inArray(shopStaff.status, OPEN_STATUSES),
          account ? eq(shopStaff.userId, account.id) : and(isNull(shopStaff.userId), sql`lower(${shopStaff.inviteEmail}) = ${inviteEmail}`),
        ),
      );
    if (existing) throw conflict("This person is already invited to or on this shop's staff.");
    const [row] = await tx
      .insert(shopStaff)
      .values({
        shopId,
        userId: account?.id ?? null,
        scope: "CATALOGUE",
        status: "INVITED",
        role: input.role,
        permissions: extra,
        inviteEmail,
        inviteTokenHash: hashInviteToken(token),
        inviteExpiresAt: expiresAt,
        invitedBy: actor.id,
        addedBy: actor.id,
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_STAFF_INVITED,
        entityType: "shop",
        entityId: shopId,
        newValue: { staffId: row.id, userId: row.userId, inviteEmail: inviteEmail ? maskEmail(inviteEmail) : null, role: input.role, permissions: extra },
      },
      tx,
    );
    if (account) {
      const [owner] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.id));
      await notify(
        {
          userId: account.id,
          type: NOTIFICATION_TYPES.SHOP_STAFF_INVITED,
          vars: { ownerName: owner?.name ?? "The shop owner", shopName: shop.name, roleLabel: SHOP_STAFF_ROLE_LABELS[input.role] },
          actionUrl: "/shop/staff-access",
          dedupeKey: `shop-staff-invited:${row.id}`,
        },
        tx,
      );
    }
    return row;
  });

  // After commit: the e-mail to a person without an account. Best effort — the owner can resend by inviting again.
  if (inviteEmail) {
    const link = siteUrl(`/staff-invite?token=${token}`);
    try {
      await sendEmail({
        to: inviteEmail,
        subject: `You are invited to ${shop.name} on GoKesari`,
        text:
          `${shop.name} invited you to join its staff on GoKesari as ${SHOP_STAFF_ROLE_LABELS[input.role]}.\n\n` +
          `Open this link, sign in with this e-mail address (we e-mail you a code), and accept:\n${link}\n\n` +
          `The link works for ${INVITE_TTL_DAYS} days. If you did not expect this, ignore this e-mail.`,
      });
    } catch (error) {
      console.error("[shop-staff] invitation e-mail failed", created.id, error);
    }
  }
  const [member] = (await listShopStaff(shopId, actor)).filter((m) => m.id === created.id);
  return member;
}

export interface MyInvitation {
  id: string;
  shopId: string;
  shopName: string;
  role: ShopStaffRole;
  effective: ShopStaffPermission[];
  expiresAt: Date | null;
}

/** Open invitations for the signed-in person: to their account, or to their e-mail address. */
export async function listMyInvitations(user: { id: string; email: string }): Promise<MyInvitation[]> {
  if (!(await shopStaffRolesEnabled())) return [];
  const email = user.email.trim().toLowerCase();
  const rows = await db
    .select({ id: shopStaff.id, shopId: shopStaff.shopId, shopName: shops.name, role: shopStaff.role, permissions: shopStaff.permissions, expiresAt: shopStaff.inviteExpiresAt })
    .from(shopStaff)
    .innerJoin(shops, eq(shops.id, shopStaff.shopId))
    .where(
      and(
        eq(shopStaff.status, "INVITED"),
        isNull(shops.deletedAt),
        gt(shopStaff.inviteExpiresAt, new Date()),
        email
          ? or(eq(shopStaff.userId, user.id), and(isNull(shopStaff.userId), sql`lower(${shopStaff.inviteEmail}) = ${email}`))
          : eq(shopStaff.userId, user.id),
      ),
    )
    .orderBy(shops.name);
  return rows.map((r) => {
    const role = isShopStaffRole(r.role) ? r.role : LEGACY_CATALOGUE_ROLE;
    return { id: r.id, shopId: r.shopId, shopName: r.shopName, role, effective: effectivePermissions(role, r.permissions), expiresAt: r.expiresAt };
  });
}

/** The invitation a link's token points at, for the accept page (no secrets). */
export async function findInvitationByToken(token: string): Promise<{ id: string; shopName: string; role: ShopStaffRole; expired: boolean } | null> {
  if (!token || token.length > 200) return null;
  const [row] = await db
    .select({ id: shopStaff.id, status: shopStaff.status, role: shopStaff.role, expiresAt: shopStaff.inviteExpiresAt, shopName: shops.name })
    .from(shopStaff)
    .innerJoin(shops, eq(shops.id, shopStaff.shopId))
    .where(eq(shopStaff.inviteTokenHash, hashInviteToken(token)));
  if (!row || row.status !== "INVITED") return null;
  return {
    id: row.id,
    shopName: row.shopName,
    role: isShopStaffRole(row.role) ? row.role : LEGACY_CATALOGUE_ROLE,
    expired: !row.expiresAt || row.expiresAt <= new Date(),
  };
}

/**
 * Accept an invitation, by its link token or (for an invitation to this
 * account) by its id. The signed-in account must be the one invited: the same
 * account, or — for an e-mail invitation — an account with that e-mail
 * address, which the e-mailed sign-in code has just verified.
 */
export async function acceptShopStaffInvite(
  input: { token?: string; staffId?: string },
  user: { id: string; email: string; role: UserRole; name?: string | null },
): Promise<{ shopId: string; shopName: string }> {
  await requireRolesFlag();
  const where = input.token
    ? eq(shopStaff.inviteTokenHash, hashInviteToken(input.token))
    : input.staffId
      ? eq(shopStaff.id, input.staffId)
      : null;
  if (!where) throw validationFailed("Open the invitation link again.");
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: shopStaff.id,
        shopId: shopStaff.shopId,
        userId: shopStaff.userId,
        status: shopStaff.status,
        role: shopStaff.role,
        inviteEmail: shopStaff.inviteEmail,
        expiresAt: shopStaff.inviteExpiresAt,
        invitedBy: shopStaff.invitedBy,
        shopName: shops.name,
        ownerId: shops.ownerId,
      })
      .from(shopStaff)
      .innerJoin(shops, and(eq(shops.id, shopStaff.shopId), isNull(shops.deletedAt)))
      .where(where)
      .for("update", { of: shopStaff });
    if (!row || row.status !== "INVITED") throw notFound("Invitation");
    const mine = row.userId
      ? row.userId === user.id
      : !!row.inviteEmail && !!user.email && row.inviteEmail.toLowerCase() === user.email.trim().toLowerCase();
    if (!mine) throw forbidden("This invitation is for someone else. Sign in with the e-mail address or mobile number it was sent to.");
    if (!row.expiresAt || row.expiresAt <= new Date()) throw validationFailed("This invitation has expired. Ask the shop owner to invite you again.");
    if (row.ownerId === user.id) throw conflict("You own this shop.");
    const [other] = await tx
      .select({ id: shopStaff.id })
      .from(shopStaff)
      .where(and(eq(shopStaff.shopId, row.shopId), eq(shopStaff.userId, user.id), inArray(shopStaff.status, ["ACTIVE", "SUSPENDED"])));
    if (other) throw conflict("You are already on this shop's staff.");
    await tx
      .update(shopStaff)
      .set({ userId: user.id, status: "ACTIVE", acceptedAt: new Date(), inviteTokenHash: null })
      .where(eq(shopStaff.id, row.id));
    await recordAudit(
      {
        actorId: user.id,
        actorRole: user.role,
        action: AUDIT_ACTIONS.SHOP_STAFF_INVITE_ACCEPTED,
        entityType: "shop",
        entityId: row.shopId,
        previousValue: { status: "INVITED" },
        newValue: { staffId: row.id, userId: user.id, role: row.role, status: "ACTIVE" },
      },
      tx,
    );
    const roleLabel = SHOP_STAFF_ROLE_LABELS[isShopStaffRole(row.role) ? row.role : LEGACY_CATALOGUE_ROLE];
    await notify(
      {
        userId: row.ownerId,
        type: NOTIFICATION_TYPES.SHOP_STAFF_INVITE_ACCEPTED,
        vars: { staffName: user.name ?? "Your invitee", shopName: row.shopName, roleLabel },
        actionUrl: "/shop/staff",
        dedupeKey: `shop-staff-accepted:${row.id}`,
      },
      tx,
    );
    return { shopId: row.shopId, shopName: row.shopName };
  });
  return result;
}

async function loadManagedRow(shopId: string, staffId: string, ctx: StaffManagerContext, client: DbClient = db) {
  const [row] = await client
    .select()
    .from(shopStaff)
    .where(and(eq(shopStaff.id, staffId), eq(shopStaff.shopId, shopId)))
    .for("update");
  if (!row) throw notFound("Staff member");
  if (ctx.granter !== null) {
    // A staff manager: not themselves, never a MANAGER, never someone holding more than they do.
    if (row.id === ctx.granterStaffId) throw forbidden("Ask the shop owner to change your own access.");
    const role = isShopStaffRole(row.role) ? row.role : LEGACY_CATALOGUE_ROLE;
    if (!canGrant(ctx.granter, role, row.permissions)) throw forbidden("Only the shop owner can change this person's access.");
  }
  return row;
}

export async function changeShopStaffRole(
  shopId: string,
  staffId: string,
  input: { role: ShopStaffRole; permissions?: readonly string[] },
  actor: ActorLike,
): Promise<void> {
  await requireRolesFlag();
  const ctx = await requireStaffManager(shopId, actor, "staff.edit");
  const extra = checkRoleInput(input.role, input.permissions);
  if (!canGrant(ctx.granter, input.role, extra)) {
    throw forbidden("You can only give permissions you have yourself, and only the owner can make someone a manager.");
  }
  await db.transaction(async (tx) => {
    const row = await loadManagedRow(shopId, staffId, ctx, tx);
    if (!OPEN_STATUSES.includes(row.status)) throw notFound("Staff member");
    await tx.update(shopStaff).set({ role: input.role, permissions: extra, roleChangedAt: new Date() }).where(eq(shopStaff.id, row.id));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_STAFF_ROLE_CHANGED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { staffId: row.id, role: row.role, permissions: row.permissions },
        newValue: { staffId: row.id, role: input.role, permissions: extra },
      },
      tx,
    );
    if (row.userId && row.status !== "INVITED") {
      await notify(
        {
          userId: row.userId,
          type: NOTIFICATION_TYPES.SHOP_STAFF_ROLE_CHANGED,
          vars: { shopName: ctx.shop.name, roleLabel: SHOP_STAFF_ROLE_LABELS[input.role] },
          actionUrl: "/shop/staff-access",
          dedupeKey: `shop-staff-role:${row.id}:${Date.now()}`,
        },
        tx,
      );
    }
  });
}

/** Pause (SUSPENDED) or restore (ACTIVE) a person's access. Takes effect on their next request. */
export async function setShopStaffSuspended(shopId: string, staffId: string, suspended: boolean, actor: ActorLike): Promise<void> {
  await requireRolesFlag();
  const ctx = await requireStaffManager(shopId, actor, "staff.edit");
  await db.transaction(async (tx) => {
    const row = await loadManagedRow(shopId, staffId, ctx, tx);
    const from = suspended ? "ACTIVE" : "SUSPENDED";
    if (row.status !== from) throw conflict(suspended ? "Only active staff can be paused." : "This person's access is not paused.");
    await tx
      .update(shopStaff)
      .set(suspended ? { status: "SUSPENDED", suspendedAt: new Date(), suspendedBy: actor.id } : { status: "ACTIVE", suspendedAt: null, suspendedBy: null })
      .where(eq(shopStaff.id, row.id));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: suspended ? AUDIT_ACTIONS.SHOP_STAFF_SUSPENDED : AUDIT_ACTIONS.SHOP_STAFF_REACTIVATED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { staffId: row.id, userId: row.userId, status: row.status },
        newValue: { status: suspended ? "SUSPENDED" : "ACTIVE" },
      },
      tx,
    );
    if (row.userId) {
      const role = isShopStaffRole(row.role) ? row.role : LEGACY_CATALOGUE_ROLE;
      await notify(
        {
          userId: row.userId,
          type: suspended ? NOTIFICATION_TYPES.SHOP_STAFF_SUSPENDED : NOTIFICATION_TYPES.SHOP_STAFF_REACTIVATED,
          vars: { shopName: ctx.shop.name, roleLabel: SHOP_STAFF_ROLE_LABELS[role] },
          dedupeKey: `shop-staff-${suspended ? "suspended" : "reactivated"}:${row.id}:${Date.now()}`,
        },
        tx,
      );
    }
  });
}

/**
 * Remove a person's access (REVOKED; kept for the audit trail). With Module 10
 * also a paused member or an open invitation (cancelled).
 */
export async function removeShopStaff(shopId: string, staffId: string, actor: ActorLike): Promise<void> {
  const rolesOn = await shopStaffRolesEnabled();
  const ctx = await requireStaffManager(shopId, actor, "staff.delete");
  const removable: StaffStatus[] = rolesOn ? OPEN_STATUSES : ["ACTIVE"];
  await db.transaction(async (tx) => {
    if (ctx.granter !== null) await loadManagedRow(shopId, staffId, ctx, tx);
    const [before] = await tx
      .select({ status: shopStaff.status })
      .from(shopStaff)
      .where(and(eq(shopStaff.id, staffId), eq(shopStaff.shopId, shopId)));
    const [row] = await tx
      .update(shopStaff)
      .set({ status: "REVOKED", revokedBy: actor.id, revokedAt: new Date(), inviteTokenHash: null })
      .where(and(eq(shopStaff.id, staffId), eq(shopStaff.shopId, shopId), inArray(shopStaff.status, removable)))
      .returning();
    if (!row) throw notFound("Staff member");
    const wasInvite = before?.status === "INVITED";
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: wasInvite ? AUDIT_ACTIONS.SHOP_STAFF_INVITE_CANCELLED : AUDIT_ACTIONS.SHOP_STAFF_REMOVED,
        entityType: "shop",
        entityId: shopId,
        previousValue: { staffId: row.id, userId: row.userId, status: before?.status ?? "ACTIVE" },
        newValue: { status: "REVOKED" },
      },
      tx,
    );
    if (row.userId && !wasInvite) {
      await notify(
        {
          userId: row.userId,
          type: NOTIFICATION_TYPES.SHOP_STAFF_REMOVED,
          vars: { shopName: ctx.shop.name },
          dedupeKey: `shop-staff-removed:${row.id}`,
        },
        tx,
      );
    }
  });
}

export interface StaffActivityEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
  createdAt: Date;
}

/**
 * What one staff member did in this shop, newest first: audit entries they
 * made since joining, on the shop itself (including every SHOP_STAFF_ACTION
 * the permission guard records), its orders and its listings.
 */
export async function listStaffActivity(shopId: string, staffId: string, actor: ActorLike, limit = 200): Promise<StaffActivityEntry[]> {
  await requireStaffManager(shopId, actor, "staff.view");
  const [row] = await db
    .select({ userId: shopStaff.userId, addedAt: shopStaff.addedAt })
    .from(shopStaff)
    .where(and(eq(shopStaff.id, staffId), eq(shopStaff.shopId, shopId)));
  if (!row) throw notFound("Staff member");
  if (!row.userId) return [];
  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      details: auditLogs.newValue,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.actorId, row.userId),
        gte(auditLogs.createdAt, row.addedAt),
        or(
          and(eq(auditLogs.entityType, "shop"), eq(auditLogs.entityId, shopId)),
          and(eq(auditLogs.entityType, "order"), sql`${auditLogs.entityId} IN (SELECT ${orders.id}::text FROM ${orders} WHERE ${orders.shopId} = ${shopId})`),
          and(
            eq(auditLogs.entityType, "shop_product"),
            sql`${auditLogs.entityId} IN (SELECT ${shopProducts.id}::text FROM ${shopProducts} WHERE ${shopProducts.shopId} = ${shopId})`,
          ),
        ),
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows;
}

/** The signed-in staff member's permissions in a shop (null when not active staff or the flag is off) — for the staff board. */
export async function myStaffPermissions(shopId: string, userId: string): Promise<ShopStaffPermission[] | null> {
  if (!(await shopStaffRolesEnabled())) return null;
  return (await activeStaffGrant(shopId, userId))?.permissions ?? null;
}

/** Shops the user is active staff of — their way in (/shop/staff-access). */
async function listShopsWhereStaffUncached(userId: string) {
  return db
    .select({ shopId: shops.id, shopName: shops.name, slug: shops.slug, addedAt: shopStaff.addedAt })
    .from(shopStaff)
    .innerJoin(shops, eq(shops.id, shopStaff.shopId))
    .where(and(eq(shopStaff.userId, userId), eq(shopStaff.status, "ACTIVE"), isNull(shops.deletedAt)))
    .orderBy(shops.name);
}

/** Memoised for one server render (layout, header and board all ask); API routes and actions call straight through. */
export const listShopsWhereStaff = cache(listShopsWhereStaffUncached);

/**
 * The shop a catalogue page works on: `requested` when the user may edit it,
 * else the user's own (newest) shop, else the only shop they are staff of.
 */
export async function resolveCatalogueShop(
  actor: ActorLike,
  requested: string | null | undefined,
): Promise<{ shopId: string; shopName: string; via: CatalogueAccessVia } | null> {
  if (requested && /^[0-9a-f-]{36}$/i.test(requested)) {
    const via = await catalogueAccessFor(requested, actor);
    if (via) {
      const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, requested));
      return { shopId: requested, shopName: shop?.name ?? "", via };
    }
  }
  const [own] = await db
    .select({ id: shops.id, name: shops.name })
    .from(shops)
    .where(and(eq(shops.ownerId, actor.id), isNull(shops.deletedAt)))
    .orderBy(desc(shops.createdAt))
    .limit(1);
  if (own) return { shopId: own.id, shopName: own.name, via: "OWNER" };
  const staffOf = await listShopsWhereStaff(actor.id);
  if (staffOf.length === 1) return { shopId: staffOf[0].shopId, shopName: staffOf[0].shopName, via: "STAFF" };
  return null;
}
