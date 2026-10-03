/**
 * Multi-role accounts (GS-003).
 *
 * A user can hold several roles — a shop owner who also delivers, a society
 * admin who also runs a shop. `users.role` stays the single ACTIVE role that
 * the session and every permission check read; the roles a user may switch
 * between live in `user_role_grants`. CUSTOMER is implicit for everyone.
 *
 * Approval stays with each role's own flow: registering a shop, applying as
 * a rider or running a verified society grants the role (so the user can
 * reach that portal), and the shop / rider / society is still approved
 * separately before it can trade. Staff roles (OPERATOR, ADMIN) are granted
 * only by an admin.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  userRoleEnum,
  userRoleGrants,
  users,
  type UserRole,
  type UserRoleGrant,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { keepExisting, updateReturning } from "@/server/db/returning";

/** Roles only an admin can grant; changing someone's staff role replaces the previous one. */
export const STAFF_ROLES: readonly UserRole[] = ["OPERATOR", "ADMIN"];

export type RoleGrantSource =
  | "SHOP_REGISTRATION"
  | "DELIVERY_PARTNER_APPLICATION"
  | "SOCIETY"
  | "ADMIN"
  | "BOOTSTRAP";

interface Actor {
  id: string;
  role: UserRole;
}

/** Active roles of a user, CUSTOMER first. */
export async function listUserRoles(
  userId: string,
  client: DbClient = db,
): Promise<UserRole[]> {
  const rows = await client
    .select({ role: userRoleGrants.role })
    .from(userRoleGrants)
    .where(
      and(
        eq(userRoleGrants.userId, userId),
        eq(userRoleGrants.status, "ACTIVE"),
      ),
    )
    .orderBy(asc(userRoleGrants.grantedAt));
  const roles = new Set<UserRole>(["CUSTOMER", ...rows.map((r) => r.role)]);
  return [...roles];
}

/** Active granted roles for many users at once (admin user list). */
export async function listRolesForUsers(
  userIds: string[],
): Promise<Map<string, UserRole[]>> {
  const map = new Map<string, UserRole[]>();
  if (userIds.length === 0) return map;
  const rows = await db
    .select({ userId: userRoleGrants.userId, role: userRoleGrants.role })
    .from(userRoleGrants)
    .where(
      and(
        inArray(userRoleGrants.userId, userIds),
        eq(userRoleGrants.status, "ACTIVE"),
      ),
    );
  for (const r of rows)
    map.set(r.userId, [...(map.get(r.userId) ?? []), r.role]);
  return map;
}

export async function listRoleGrants(userId: string): Promise<UserRoleGrant[]> {
  return db
    .select()
    .from(userRoleGrants)
    .where(eq(userRoleGrants.userId, userId))
    .orderBy(asc(userRoleGrants.grantedAt));
}

/**
 * Grants `role` (idempotent; re-activates a revoked grant). With
 * `activateIfCustomer`, a user currently acting as CUSTOMER switches to the
 * new role straight away — the behaviour the single-role flows had.
 */
export async function grantRole(
  userId: string,
  role: UserRole,
  options: {
    source: RoleGrantSource;
    grantedBy?: string | null;
    activateIfCustomer?: boolean;
  },
  client: DbClient = db,
): Promise<void> {
  if (role === "CUSTOMER") return;
  const [existing] = await client
    .select()
    .from(userRoleGrants)
    .where(
      and(eq(userRoleGrants.userId, userId), eq(userRoleGrants.role, role)),
    );
  if (!existing) {
    await client
      .insert(userRoleGrants)
      .values({
        userId,
        role,
        source: options.source,
        grantedBy: options.grantedBy ?? null,
      })
      .onDuplicateKeyUpdate({ set: keepExisting(userRoleGrants) });
  } else if (existing.status !== "ACTIVE") {
    await client
      .update(userRoleGrants)
      .set({
        status: "ACTIVE",
        source: options.source,
        grantedBy: options.grantedBy ?? null,
        grantedAt: new Date(),
        revokedBy: null,
        revokedAt: null,
      })
      .where(eq(userRoleGrants.id, existing.id));
  } else {
    // Already held — nothing to record.
    if (options.activateIfCustomer)
      await activateIfCustomer(userId, role, client);
    return;
  }

  if (options.activateIfCustomer)
    await activateIfCustomer(userId, role, client);
  await recordAudit(
    {
      actorId: options.grantedBy ?? userId,
      action: AUDIT_ACTIONS.ROLE_GRANTED,
      entityType: "user",
      entityId: userId,
      newValue: { role, source: options.source },
    },
    client,
  );
}

async function activateIfCustomer(
  userId: string,
  role: UserRole,
  client: DbClient,
): Promise<void> {
  await client
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.role, "CUSTOMER")));
}

/** The user switches their active role to one they hold (header role switcher). */
export async function switchActiveRole(
  userId: string,
  role: UserRole,
): Promise<UserRole> {
  if (!(userRoleEnum.enumValues as readonly string[]).includes(role)) {
    throw validationFailed("Not a recognised role.");
  }
  const held = await listUserRoles(userId);
  if (!held.includes(role)) throw forbidden("You do not hold that role.");

  const [current] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId));
  if (!current) throw notFound("User");
  if (current.role === role) return role;

  await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await recordAudit({
    actorId: userId,
    actorRole: current.role,
    action: AUDIT_ACTIONS.ROLE_SWITCHED,
    entityType: "user",
    entityId: userId,
    previousValue: { role: current.role },
    newValue: { role },
  });
  return role;
}

/**
 * Admin revokes one role. If it was the active role the user falls back to
 * CUSTOMER. An admin cannot revoke their own roles (no self-lockout).
 */
export async function revokeRole(
  userId: string,
  role: UserRole,
  actor: Actor,
): Promise<void> {
  if (role === "CUSTOMER")
    throw validationFailed("Every account keeps the customer role.");
  if (userId === actor.id) throw forbidden("You cannot change your own roles.");

  await db.transaction(async (tx) => {
    const [grant] = await updateReturning(
      tx,
      userRoleGrants,
      { status: "REVOKED", revokedBy: actor.id, revokedAt: new Date() },
      and(
        eq(userRoleGrants.userId, userId),
        eq(userRoleGrants.role, role),
        eq(userRoleGrants.status, "ACTIVE"),
      ),
    );
    if (!grant) throw conflict("That user does not hold this role.");

    await tx
      .update(users)
      .set({ role: "CUSTOMER", updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.role, role)));

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.ROLE_REVOKED,
        entityType: "user",
        entityId: userId,
        previousValue: { role },
      },
      tx,
    );
  });
}

/**
 * Admin sets a user's role (the existing role manager): the role is granted
 * and made active. Staff roles are exclusive — granting OPERATOR removes
 * ADMIN and vice versa, and setting any non-staff role removes both, so a
 * demotion cannot be undone by switching back.
 */
export async function assignRoleByAdmin(
  userId: string,
  role: UserRole,
  actor: Actor,
  client: DbClient = db,
): Promise<void> {
  for (const staff of STAFF_ROLES) {
    if (staff === role) continue;
    await client
      .update(userRoleGrants)
      .set({ status: "REVOKED", revokedBy: actor.id, revokedAt: new Date() })
      .where(
        and(
          eq(userRoleGrants.userId, userId),
          eq(userRoleGrants.role, staff),
          eq(userRoleGrants.status, "ACTIVE"),
        ),
      );
  }
  await grantRole(
    userId,
    role,
    { source: "ADMIN", grantedBy: actor.id },
    client,
  );
}
