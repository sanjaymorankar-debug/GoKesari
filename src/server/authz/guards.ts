/**
 * Server-side authorization guards.
 *
 * Every mutating route handler and server action begins with one of these.
 * They answer capability ("may this role?") and ownership ("is this row mine?")
 * as separate checks, both of which must pass.
 */
import { cache } from "react";
import { and, eq, isNull } from "drizzle-orm";

import { forbidden, notFound, unauthenticated } from "@/lib/errors";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { shops, subscriptions, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { can, type Permission } from "./permissions";

/**
 * docs/rbac §11: every refused permission check is logged. Fire-and-forget (recordAudit never
 * throws), so the refusal the caller sees is unchanged. At most DENIAL_LOG_CAP rows per user per
 * minute, so a page polling a forbidden endpoint cannot flood the audit log.
 */
const DENIAL_LOG_CAP = 20;
const denialWindow = new Map<string, { minute: number; count: number }>();

export function logDenied(user: Pick<AuthenticatedUser, "id" | "role">, needed: string, kind: "permission" | "role" | "shop"): void {
  const minute = Math.floor(Date.now() / 60_000);
  const seen = denialWindow.get(user.id);
  if (seen && seen.minute === minute) {
    if (seen.count >= DENIAL_LOG_CAP) return;
    seen.count += 1;
  } else {
    if (denialWindow.size > 5_000) denialWindow.clear();
    denialWindow.set(user.id, { minute, count: 1 });
  }
  void recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.AUTHZ_DENIED,
    entityType: kind,
    entityId: needed.slice(0, 200),
    newValue: { needed, kind },
  });
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: UserRole;
}

/** The session for one server render: layout, header, board and page all ask; API routes call straight through. */
const currentSession = cache(() => auth());

/** Returns the signed-in user, or null. Never throws. */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const session = await currentSession();
  if (!session?.user?.id) return null;
  if (session.user.status !== "ACTIVE") return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name ?? null,
    image: session.user.image ?? null,
    role: session.user.role,
  };
}

/** Throws UNAUTHENTICATED if there is no active session. */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthenticated();
  return user;
}

/**
 * docs/dual-auth-2026-11 (flag dual_auth): staff (admin, operator and every internal role) and a shop owner on
 * their own shop need BOTH factors verified on the account; a one-factor account gets 403 with
 * details.dualAuth = NEEDS_SECOND_FACTOR and the DualVerify link. Customers are gated where they order or
 * withdraw (checkout route, wallet), so browsing APIs stay open to them.
 */
async function dualGate(user: AuthenticatedUser, action: "ADMIN" | "SHOP" | "DEALER"): Promise<void> {
  const { assertDualVerified, isStaffRole } = await import("@/server/dual-auth/policy");
  if (action === "ADMIN" && !isStaffRole(user.role)) return;
  await assertDualVerified(user.id, action);
}

/** Throws FORBIDDEN if the signed-in user's role lacks the capability. */
export async function requirePermission(
  permission: Permission,
): Promise<AuthenticatedUser> {
  const user = await requireUser();
  if (!can(user.role, permission)) {
    logDenied(user, permission, "permission");
    throw forbidden("You do not have permission to perform this action.");
  }
  await dualGate(user, "ADMIN");
  return user;
}

export async function requireAnyPermission(
  permissions: readonly Permission[],
): Promise<AuthenticatedUser> {
  const user = await requireUser();
  if (!permissions.some((p) => can(user.role, p))) {
    logDenied(user, permissions.join("|"), "permission");
    throw forbidden("You do not have permission to perform this action.");
  }
  await dualGate(user, "ADMIN");
  return user;
}

export async function requireRole(
  ...roles: readonly UserRole[]
): Promise<AuthenticatedUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) {
    logDenied(user, roles.join("|"), "role");
    throw forbidden("You do not have access to this area.");
  }
  await dualGate(user, "ADMIN");
  return user;
}

/**
 * Ownership check for shop-scoped operations.
 *
 * A SHOP_OWNER passes only for their own shop. OPERATOR/ADMIN pass for any shop
 * when they hold the corresponding `:any` capability — this is what stops one
 * shop owner from editing another's catalogue (§4).
 */
export async function requireShopAccess(
  shopId: string,
  options: { anyPermission: Permission },
): Promise<{ user: AuthenticatedUser; isPrivileged: boolean }> {
  const user = await requireUser();

  const shop = await db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),
    columns: { id: true, ownerId: true },
  });
  if (!shop) throw notFound("Shop");

  if (shop.ownerId === user.id) {
    await dualGate(user, "SHOP");
    return { user, isPrivileged: false };
  }

  if (can(user.role, options.anyPermission)) {
    await dualGate(user, "ADMIN");
    return { user, isPrivileged: true };
  }
  logDenied(user, `${options.anyPermission}@shop:${shopId}`, "shop");
  throw forbidden("This shop does not belong to you.");
}

/**
 * requireShopAccess without the throw, for public reads that show a shop's
 * owner and staff more than everyone else. Null for anyone who would be
 * refused — signed out, another owner, staff without the capability — and
 * for a shop that does not exist.
 */
export async function getShopAccess(
  shopId: string,
  options: { anyPermission: Permission },
): Promise<{ user: AuthenticatedUser; isPrivileged: boolean } | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const shop = await db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),
    columns: { id: true, ownerId: true },
  });
  if (!shop) return null;

  if (shop.ownerId === user.id) return { user, isPrivileged: false };
  if (can(user.role, options.anyPermission)) return { user, isPrivileged: true };
  return null;
}

/** Ownership check for subscription-scoped operations. */
export async function requireSubscriptionAccess(
  subscriptionId: string,
  options: { anyPermission: Permission },
): Promise<{ user: AuthenticatedUser; isPrivileged: boolean }> {
  const user = await requireUser();

  const subscription = await db.query.subscriptions.findFirst({
    where: eq(subscriptions.id, subscriptionId),
    columns: { id: true, userId: true },
  });
  if (!subscription) throw notFound("Subscription");

  if (subscription.userId === user.id) return { user, isPrivileged: false };

  if (can(user.role, options.anyPermission)) {
    return { user, isPrivileged: true };
  }
  throw forbidden("This subscription does not belong to you.");
}
