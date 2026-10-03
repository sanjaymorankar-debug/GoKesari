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
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  like,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";

import { permanentBootstrapAdminEmails } from "@/lib/env";
import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  deliveryPartners,
  userRoleGrants,
  users,
  userRoleEnum,
  type User,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { suspendDeliveryPartner } from "./delivery-partners";
import { NOTIFICATION_TYPES, notifyEvent } from "./notifications";
import { assignRoleByAdmin, grantRole } from "./roles";
import { updateReturning } from "@/server/db/returning";

export interface ListUsersOptions {
  query?: string;
  role?: UserRole;
  limit?: number;
  offset?: number;
}

export async function listUsers(
  options: ListUsersOptions = {},
): Promise<User[]> {
  const conditions = [];
  if (options.query) {
    const term = `%${options.query}%`;
    conditions.push(or(like(users.email, term), like(users.name, term))!);
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
    const [row] = await updateReturning(
      tx,
      users,
      { role, updatedAt: new Date() },
      eq(users.id, userId),
    );
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
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_ROLE_CHANGED, userId, {
    detail: `${current.role} → ${role}`,
  });
  return updated;
}

const ADMIN_NOT_SUSPENDABLE =
  "An admin account cannot be suspended. Remove its admin role first.";

/** Which of these accounts are admins (see the header: any ACTIVE ADMIN grant, active role or permanent admin email). */
export async function findAdminUserIds(
  userIds: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (userIds.length === 0) return found;
  const [accounts, grants] = await Promise.all([
    db
      .select({ id: users.id, role: users.role, email: users.email })
      .from(users)
      .where(inArray(users.id, userIds)),
    db
      .select({ userId: userRoleGrants.userId })
      .from(userRoleGrants)
      .where(
        and(
          inArray(userRoleGrants.userId, userIds),
          eq(userRoleGrants.role, "ADMIN"),
          eq(userRoleGrants.status, "ACTIVE"),
        ),
      ),
  ]);
  const permanent = new Set(permanentBootstrapAdminEmails());
  for (const a of accounts) {
    if (a.role === "ADMIN" || permanent.has(a.email.toLowerCase()))
      found.add(a.id);
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
  if (trimmed.length < 3)
    throw validationFailed("A suspension reason is required.");
  if (userId === actor.id)
    throw forbidden("You cannot suspend your own account.");

  const target = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { status: true, deletedAt: true },
  });
  if (!target) throw notFound("User");
  if ((await findAdminUserIds([userId])).has(userId))
    throw forbidden(ADMIN_NOT_SUSPENDABLE);
  if (target.status !== "ACTIVE" || target.deletedAt)
    throw conflict("Only an active account can be suspended.");

  // A rider profile goes offline first: if that fails the account is untouched and the request can be retried.
  const riders = await db
    .select({ id: deliveryPartners.id })
    .from(deliveryPartners)
    .where(
      and(
        eq(deliveryPartners.userId, userId),
        eq(deliveryPartners.status, "APPROVED"),
        isNull(deliveryPartners.deletedAt),
      ),
    );
  for (const rider of riders) {
    await suspendDeliveryPartner(
      rider.id,
      "The account was suspended by operations.",
      actor,
    );
  }

  const [updated] = await updateReturning(
    db,
    users,
    { status: "SUSPENDED", updatedAt: new Date() },
    and(
      eq(users.id, userId),
      eq(users.status, "ACTIVE"),
      isNull(users.deletedAt),
      ne(users.role, "ADMIN"),
      notExists(
        db
          .select({ id: userRoleGrants.id })
          .from(userRoleGrants)
          .where(
            and(
              eq(userRoleGrants.userId, users.id),
              eq(userRoleGrants.role, "ADMIN"),
              eq(userRoleGrants.status, "ACTIVE"),
            ),
          ),
      ),
    ),
  );
  if (!updated) {
    if ((await findAdminUserIds([userId])).has(userId))
      throw forbidden(ADMIN_NOT_SUSPENDABLE);
    throw conflict("Only an active account can be suspended.");
  }

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.USER_SUSPENDED,
    entityType: "user",
    entityId: userId,
    previousValue: { status: "ACTIVE" },
    newValue: {
      status: "SUSPENDED",
      reason: trimmed,
      ...(riders.length > 0
        ? { deliveryPartnersSuspended: riders.length }
        : {}),
    },
  });
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_ACCOUNT_STATUS, userId, {
    status: "suspended",
    detail: `Reason: ${trimmed}`,
  });
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
  if (trimmed.length < 3)
    throw validationFailed("A reinstatement reason is required.");

  const [updated] = await updateReturning(
    db,
    users,
    { status: "ACTIVE", updatedAt: new Date() },
    and(
      eq(users.id, userId),
      eq(users.status, "SUSPENDED"),
      isNull(users.deletedAt),
    ),
  );
  if (!updated) {
    const target = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true },
    });
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
  await notifyEvent(NOTIFICATION_TYPES.SECURITY_ACCOUNT_STATUS, userId, {
    status: "reinstated",
    detail: "You can sign in again.",
  });
  return updated;
}

/* ------------------------------------------------------- privileges screen */

/**
 * One admin's view of another account's privileges: the role they are acting
 * as, and the roles they hold and may switch between.
 */
export interface PrivilegesSnapshot {
  activeRole: UserRole;
  heldRoles: UserRole[];
}

export interface PrivilegesResult {
  previous: PrivilegesSnapshot;
  next: PrivilegesSnapshot;
  changed: boolean;
}

const sortRoles = (roles: Iterable<UserRole>): UserRole[] =>
  [...new Set(roles)].sort(
    (a, b) =>
      userRoleEnum.enumValues.indexOf(a) - userRoleEnum.enumValues.indexOf(b),
  );

/** CUSTOMER is implicit for every account (roles.ts), so it is always held. */
const normaliseHeld = (roles: readonly UserRole[]): UserRole[] =>
  sortRoles(["CUSTOMER", ...roles]);

const hasAdminRight = (snapshot: PrivilegesSnapshot): boolean =>
  snapshot.activeRole === "ADMIN" || snapshot.heldRoles.includes("ADMIN");

/** Is there an active admin account other than `excludeUserId`? */
async function anotherAdminExists(
  excludeUserId: string,
  client: DbClient = db,
): Promise<boolean> {
  const permanent = permanentBootstrapAdminEmails();
  const [row] = await client
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        ne(users.id, excludeUserId),
        isNull(users.deletedAt),
        eq(users.status, "ACTIVE"),
        or(
          eq(users.role, "ADMIN"),
          permanent.length > 0
            ? inArray(sql`lower(${users.email})`, permanent)
            : undefined,
          exists(
            db
              .select({ x: sql`1` })
              .from(userRoleGrants)
              .where(
                and(
                  eq(userRoleGrants.userId, users.id),
                  eq(userRoleGrants.role, "ADMIN"),
                  eq(userRoleGrants.status, "ACTIVE"),
                ),
              ),
          ),
        )!,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Saves a whole privileges draft in one transaction — the active role and the
 * set of held roles together.
 *
 * `setUserRole()` above remains for the single-field API; this is what the
 * admin privileges screen posts, because an admin editing a role *and* removing
 * a grant used to be two requests that could half-apply. Here either both land
 * or neither does.
 *
 * Guard rails, all re-checked server-side against rows read inside the same
 * transaction that writes — a crafted request body gets the same answer as the
 * UI would give:
 *  - an actor may not change their own privileges at all (the pre-existing rule
 *    in `setUserRole`/`revokeRole`), and the error says so explicitly when the
 *    draft would have cost them their last admin right;
 *  - the platform may never be left with no admin account;
 *  - a permanent bootstrap admin (PERMANENT_ADMIN_EMAILS) cannot have ADMIN
 *    taken away here — auth.ts re-grants it on the next session refresh, so
 *    accepting the save would be a lie;
 *  - OPERATOR and ADMIN stay mutually exclusive, as `assignRoleByAdmin` has it;
 *  - the active role must be one of the held roles.
 */
export async function updateUserPrivileges(
  userId: string,
  input: { activeRole: UserRole; heldRoles: readonly UserRole[] },
  actor: { id: string; role: UserRole },
): Promise<PrivilegesResult> {
  const activeRole = input.activeRole;
  if (!VALID_ROLES.has(activeRole))
    throw validationFailed("Not a recognised role.");
  for (const role of input.heldRoles) {
    if (!VALID_ROLES.has(role))
      throw validationFailed("Not a recognised role.");
  }

  const wantedHeld = normaliseHeld(input.heldRoles);
  if (!wantedHeld.includes(activeRole)) {
    throw validationFailed("The account must hold the role it is acting as.");
  }
  if (wantedHeld.includes("OPERATOR") && wantedHeld.includes("ADMIN")) {
    throw validationFailed(
      "An account cannot hold both Operator and Administrator. Choose one.",
    );
  }

  // Everything from here runs in one transaction: the state the guards judge is
  // the state that gets written, so two admins saving at the same moment cannot
  // both pass the "another admin exists" check and leave nobody holding it.
  const result = await db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!target || target.deletedAt) throw notFound("User");

    const currentGrants = await tx
      .select({ role: userRoleGrants.role })
      .from(userRoleGrants)
      .where(
        and(
          eq(userRoleGrants.userId, userId),
          eq(userRoleGrants.status, "ACTIVE"),
        ),
      );

    const previous: PrivilegesSnapshot = {
      activeRole: target.role,
      heldRoles: normaliseHeld(currentGrants.map((g) => g.role)),
    };
    const next: PrivilegesSnapshot = { activeRole, heldRoles: wantedHeld };

    if (
      previous.activeRole === next.activeRole &&
      previous.heldRoles.join(",") === next.heldRoles.join(",")
    ) {
      return { previous, next, changed: false as const };
    }

    // Self-protection. The pre-existing rule is that nobody edits their own
    // privileges; the last-admin-right case gets its own wording because that
    // is the mistake worth naming.
    if (userId === actor.id) {
      throw forbidden(
        hasAdminRight(previous) && !hasAdminRight(next)
          ? "You cannot remove your own last administrator right. Ask another administrator to do it."
          : "You cannot change your own privileges.",
      );
    }

    if (
      permanentBootstrapAdminEmails().includes(target.email.toLowerCase()) &&
      !hasAdminRight(next)
    ) {
      throw conflict(
        "This account is a permanent administrator (PERMANENT_ADMIN_EMAILS) and would be granted ADMIN again on its next sign-in. Remove it from that list first.",
      );
    }

    // Never leave the platform with nobody who can administer it. Asked as
    // "does another admin exist?" rather than by listing every account, so the
    // check stays cheap as the user table grows.
    if (
      hasAdminRight(previous) &&
      !hasAdminRight(next) &&
      !(await anotherAdminExists(userId, tx))
    ) {
      throw conflict(
        "This is the only administrator account left. Grant admin to someone else first.",
      );
    }

    for (const role of previous.heldRoles) {
      if (role === "CUSTOMER" || next.heldRoles.includes(role)) continue;
      await tx
        .update(userRoleGrants)
        .set({ status: "REVOKED", revokedBy: actor.id, revokedAt: new Date() })
        .where(
          and(
            eq(userRoleGrants.userId, userId),
            eq(userRoleGrants.role, role),
            eq(userRoleGrants.status, "ACTIVE"),
          ),
        );
    }
    for (const role of next.heldRoles) {
      if (role === "CUSTOMER" || previous.heldRoles.includes(role)) continue;
      await grantRole(
        userId,
        role,
        { source: "ADMIN", grantedBy: actor.id },
        tx,
      );
    }
    if (previous.activeRole !== next.activeRole) {
      await tx
        .update(users)
        .set({ role: next.activeRole, updatedAt: new Date() })
        .where(eq(users.id, userId));
    }

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.USER_PRIVILEGES_UPDATED,
        entityType: "user",
        entityId: userId,
        previousValue: previous,
        newValue: next,
      },
      tx,
    );
    return { previous, next, changed: true as const };
  });

  // Outside the transaction: the person is only told once the change is real.
  if (result.changed && result.previous.activeRole !== result.next.activeRole) {
    await notifyEvent(NOTIFICATION_TYPES.SECURITY_ROLE_CHANGED, userId, {
      detail: `${result.previous.activeRole} → ${result.next.activeRole}`,
    });
  }
  return result;
}

/** What the privileges screen renders, including why a field may be locked. */
export async function getUserPrivileges(
  userId: string,
): Promise<PrivilegesSnapshot & { isPermanentAdmin: boolean }> {
  const [target] = await db
    .select({
      email: users.email,
      role: users.role,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!target || target.deletedAt) throw notFound("User");
  const grants = await db
    .select({ role: userRoleGrants.role })
    .from(userRoleGrants)
    .where(
      and(
        eq(userRoleGrants.userId, userId),
        eq(userRoleGrants.status, "ACTIVE"),
      ),
    );
  return {
    activeRole: target.role,
    heldRoles: normaliseHeld(grants.map((g) => g.role)),
    isPermanentAdmin: permanentBootstrapAdminEmails().includes(
      target.email.toLowerCase(),
    ),
  };
}

/* ---------------------------------------------------- profile screen (admin) */

export interface AdminProfilePatch {
  name?: string | null;
  phone?: string | null;
  status?: "ACTIVE" | "SUSPENDED";
  /** Required by suspendUser/reinstateUser when `status` changes. */
  statusReason?: string;
}

export interface ProfileUpdateResult {
  /** Field names that actually changed, for the confirmation message. */
  changedFields: string[];
  status: "ACTIVE" | "SUSPENDED";
}

/**
 * An admin edits another account's profile from `/admin/users/[id]`.
 *
 * Only what an admin can legitimately know is editable. `email` is the OAuth
 * identity and the unique login key; `phoneE164` and `phoneVerifiedAt` mean
 * "possession of this number was proven by SMS" and must never be settable by
 * someone typing on the account holder's behalf — so `phone` here is the
 * free-text contact column only, and login is unaffected by it.
 *
 * A status change is delegated to `suspendUser()` / `reinstateUser()` rather
 * than writing the column, so the existing rules still apply: a reason is
 * recorded, an admin account cannot be suspended, and a rider profile goes
 * offline with the account.
 */
export async function updateUserProfileByAdmin(
  userId: string,
  patch: AdminProfilePatch,
  actor: { id: string; role: UserRole },
): Promise<ProfileUpdateResult> {
  const [current] = await db
    .select({
      id: users.id,
      name: users.name,
      phone: users.phone,
      status: users.status,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!current || current.deletedAt) throw notFound("User");

  const set: Partial<typeof users.$inferInsert> = {};
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const changedFields: string[] = [];

  if (patch.name !== undefined) {
    const name = patch.name?.trim() || null;
    if (name !== null && (name.length < 2 || name.length > 120)) {
      throw validationFailed("A name needs 2–120 characters.", {
        fields: { name: "A name needs 2–120 characters." },
      });
    }
    if (name !== current.name) {
      set.name = name;
      previousValue.name = current.name;
      newValue.name = name;
      changedFields.push("name");
    }
  }

  if (patch.phone !== undefined) {
    const phone = patch.phone?.replace(/[\s-]/g, "") || null;
    if (phone !== null && !/^\+?\d{6,15}$/.test(phone)) {
      throw validationFailed("Enter a valid contact number, digits only.", {
        fields: { phone: "Enter a valid contact number, digits only." },
      });
    }
    if (phone !== current.phone) {
      set.phone = phone;
      previousValue.phone = current.phone;
      newValue.phone = phone;
      changedFields.push("phone");
    }
  }

  if (Object.keys(set).length > 0) {
    set.updatedAt = new Date();
    await db.update(users).set(set).where(eq(users.id, userId));
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.USER_PROFILE_UPDATED,
      entityType: "user",
      entityId: userId,
      previousValue,
      newValue,
    });
  }

  let status =
    current.status === "SUSPENDED"
      ? ("SUSPENDED" as const)
      : ("ACTIVE" as const);
  if (patch.status !== undefined && patch.status !== current.status) {
    const reason = patch.statusReason?.trim() ?? "";
    if (reason.length < 3) {
      throw validationFailed("Give a reason for the account status change.", {
        fields: {
          statusReason: "Give a reason for the account status change.",
        },
      });
    }
    // Both audit the change themselves and notify the account holder.
    const result =
      patch.status === "SUSPENDED"
        ? await suspendUser(userId, reason, actor)
        : await reinstateUser(userId, reason, actor);
    status = result.status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE";
    changedFields.push("account status");
  }

  return { changedFields, status };
}
