/**
 * User administration (requirement §5): listing accounts and changing roles.
 *
 * Role assignment is the one place an ADMIN can reshape another user's
 * capabilities, so every change is audit-logged and an actor may never change
 * their own role — that mirrors SELF_ASSIGNABLE_ROLES in authz/permissions.ts
 * and stops an admin from ever locking themselves out by mistake.
 */
import { and, desc, eq, ilike, or } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
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
