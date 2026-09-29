/**
 * User administration (requirement §5): listing accounts, changing roles and
 * suspending accounts (never your own, never an admin's). A suspended account
 * cannot sign in, and an existing session stops working on its next request
 * (auth.ts re-reads the status; getCurrentUser() rejects anything but ACTIVE).
 *
 * Role assignment is the one place an ADMIN can reshape another user's
 * capabilities, so every change is audit-logged and an actor may never change
 * their own role — that mirrors SELF_ASSIGNABLE_ROLES in authz/permissions.ts
 * and stops an admin from ever locking themselves out by mistake.
 */
import { and, desc, eq, ilike, isNull, ne, or } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { users, userRoleEnum, type User, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
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
  return updated;
}

export async function suspendUser(
  userId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<Pick<User, "id" | "status">> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) throw validationFailed("A suspension reason is required.");
  if (userId === actor.id) throw forbidden("You cannot suspend your own account.");

  const [updated] = await db
    .update(users)
    .set({ status: "SUSPENDED", updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.status, "ACTIVE"), isNull(users.deletedAt), ne(users.role, "ADMIN")))
    .returning({ id: users.id, status: users.status });
  if (!updated) {
    const target = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { role: true } });
    if (!target) throw notFound("User");
    if (target.role === "ADMIN") throw forbidden("An admin account cannot be suspended. Change its role first.");
    throw conflict("Only an active account can be suspended.");
  }

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.USER_SUSPENDED,
    entityType: "user",
    entityId: userId,
    previousValue: { status: "ACTIVE" },
    newValue: { status: "SUSPENDED", reason: trimmed },
  });
  return updated;
}
