/**
 * User administration (requirement §5): listing accounts, changing roles,
 * suspending accounts (never your own, never an admin's) and reinstating them.
 * A suspended account cannot sign in, and an existing session stops working on
 * its next request (auth.ts re-reads the status; getCurrentUser() rejects
 * anything but ACTIVE). "Admin" means any ACTIVE ADMIN grant, the active role
 * or a permanent bootstrap admin email: users.role is only the ACTIVE role
 * (GS-003), so an admin acting as a customer is still protected.
 *
 * Role assignment is the one place an ADMIN can reshape another user's
 * capabilities, so every change is audit-logged and an actor may never change
 * their own role — that mirrors SELF_ASSIGNABLE_ROLES in authz/permissions.ts
 * and stops an admin from ever locking themselves out by mistake.
 */
import { and, desc, eq, ilike, inArray, isNull, ne, notExists, or } from "drizzle-orm";

import { permanentBootstrapAdminEmails } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { deliveryPartners, userRoleGrants, users, userRoleEnum, type User, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { suspendDeliveryPartner } from "./delivery-partners";
import { NOTIFICATION_TYPES, notifyEvent } from "./notifications";
import { assignRoleByAdmin } from "./roles";

export interface ListUsersOptions {
  query?: string;
  role?: UserRole;
  limit?: number;
  offset?: number;
}

export async function listUsers(options: ListUsersOptions = {}): Promise<User[]> {
  const conditions = [];
  if (options.query) {
    const term = `%${options.query}%`;
    conditions.push(or(ilike(users.email, term), ilike(users.name, term))!);
  }
  if (options.role) conditions.push(eq(users.role, options.role));

  return db
    .select()
    .from(users)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(Math.min(options.limit ?? 50, 200))
    .offset(options.offset ?? 0);
}

const VALID_ROLES = new Set<string>(userRoleEnum.enumValues);

/** Changes a user's role (§5). ADMIN only — enforced by the route guard. */
export async function setUserRole(
  userId: string,
  role: UserRole,
  actor: { id: string; role: UserRole },
): Promise<User> {
  if (!VALID_ROLES.has(role)) {
    throw validationFailed("Not a recognised role.");
  }
  if (userId === actor.id) {
    throw forbidden("You cannot change your own role.");
  }

  const [current] = await db.select().from(users).where(eq(users.id, userId));
  if (!current) throw notFound("User");

  if (current.role === role) return current;

  // GS-003: the role is granted and made active; a staff demotion also
  // removes the staff grant so the user cannot switch back to it.
  const updated = await db.transaction(async (tx) => {
    await assignRoleByAdmin(userId, role, actor, tx);
    const [row] = await tx
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning();
    return row;
  });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
    entityType: "user",
    entityId: userId,
    previousValue: { role: current.role },
    newValue: { role },
  });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_ROLE_CHANGED, userId, { detail: `${current.role} → ${role}` });
  return updated;
}

const ADMIN_NOT_SUSPENDABLE = "An admin account cannot be suspended. Remove its admin role first.";

/** Which of these accounts are admins (see the header: any ACTIVE ADMIN grant, active role or permanent admin email). */
export async function findAdminUserIds(userIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (userIds.length === 0) return found;
  const [accounts, grants] = await Promise.all([
    db.select({ id: users.id, role: users.role, email: users.email }).from(users).where(inArray(users.id, userIds)),
    db
      .select({ userId: userRoleGrants.userId })
      .from(userRoleGrants)
      .where(and(inArray(userRoleGrants.userId, userIds), eq(userRoleGrants.role, "ADMIN"), eq(userRoleGrants.status, "ACTIVE"))),
  ]);
  const permanent = new Set(permanentBootstrapAdminEmails());
  for (const a of accounts) {
    if (a.role === "ADMIN" || permanent.has(a.email.toLowerCase())) found.add(a.id);
  }
  for (const g of grants) found.add(g.userId);
  return found;
}

export async function suspendUser(
  userId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Pick<User, "id" | "status">> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw validationFailed("A suspension reason is required.");
  if (userId === actor.id) throw forbidden("You cannot suspend your own account.");

  const target = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { status: true, deletedAt: true },
  });
  if (!target) throw notFound("User");
  if ((await findAdminUserIds([userId])).has(userId)) throw forbidden(ADMIN_NOT_SUSPENDABLE);
  if (target.status !== "ACTIVE" || target.deletedAt) throw conflict("Only an active account can be suspended.");

  // A rider profile goes offline first: if that fails the account is untouched and the request can be retried.
  const riders = await db
    .select({ id: deliveryPartners.id })
    .from(deliveryPartners)
    .where(and(eq(deliveryPartners.userId, userId), eq(deliveryPartners.status, "APPROVED"), isNull(deliveryPartners.deletedAt)));
  for (const rider of riders) {
    await suspendDeliveryPartner(rider.id, "The account was suspended by operations.", actor);
  }

  const [updated] = await db
    .update(users)
    .set({ status: "SUSPENDED", updatedAt: new Date() })
    .where(
      and(
        eq(users.id, userId),
        eq(users.status, "ACTIVE"),
        isNull(users.deletedAt),
        ne(users.role, "ADMIN"),
        notExists(
          db
            .select({ id: userRoleGrants.id })
            .from(userRoleGrants)
            .where(and(eq(userRoleGrants.userId, users.id), eq(userRoleGrants.role, "ADMIN"), eq(userRoleGrants.status, "ACTIVE"))),
        ),
      ),
    )
    .returning({ id: users.id, status: users.status });
  if (!updated) {
    if ((await findAdminUserIds([userId])).has(userId)) throw forbidden(ADMIN_NOT_SUSPENDABLE);
    throw conflict("Only an active account can be suspended.");
  }

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.USER_SUSPENDED,
    entityType: "user",
    entityId: userId,
    previousValue: { status: "ACTIVE" },
    newValue: { status: "SUSPENDED", reason: trimmed, ...(riders.length > 0 ? { deliveryPartnersSuspended: riders.length } : {}) },
  });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_ACCOUNT_STATUS, userId, { status: "suspended", detail: `Reason: ${trimmed}` });
  return updated;
}

/**
 * Lifts a suspension (ADMIN only, enforced by the route guard). Only the
 * account comes back: a rider profile suspended with it stays SUSPENDED until
 * it is reactivated from the delivery partner queue, and a suspended shop
 * still needs its own re-approval.
 */
export async function reinstateUser(
  userId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Pick<User, "id" | "status">> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw validationFailed("A reinstatement reason is required.");

  const [updated] = await db
    .update(users)
    .set({ status: "ACTIVE", updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.status, "SUSPENDED"), isNull(users.deletedAt)))
    .returning({ id: users.id, status: users.status });
  if (!updated) {
    const target = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { id: true } });
    if (!target) throw notFound("User");
    throw conflict("Only a suspended account can be reinstated.");
  }

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.USER_REINSTATED,
    entityType: "user",
    entityId: userId,
    previousValue: { status: "SUSPENDED" },
    newValue: { status: "ACTIVE", reason: trimmed },
  });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_ACCOUNT_STATUS, userId, { status: "reinstated", detail: "You can sign in again." });
  return updated;
}
