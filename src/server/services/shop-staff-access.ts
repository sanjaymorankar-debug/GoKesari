/**
 * Module 10 (docs/shop-staff-roles-2026-11): what an active shop staff member
 * may do in one shop. Read from the database on every request, so a
 * suspension, a role change or a removal takes effect on the next request.
 *
 * Behind feature flag `shop_staff_roles_enabled` (OFF): with it off,
 * `shopStaffCan` grants staff nothing beyond the owner's own access, and staff
 * keep only the catalogue (photos and descriptions) access of Module 1, which
 * `catalogueAccessFor` (shop-staff.ts) checks on its own routes.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  effectivePermissions,
  permissionAllows,
  type ShopStaffPermission,
  type ShopStaffRole,
  isShopStaffRole,
  LEGACY_CATALOGUE_ROLE,
} from "@/lib/shop-staff/permissions";
import { db, type DbClient } from "@/server/db";
import { shopStaff, shops } from "@/server/db/schema";
import { isFeatureEnabled } from "./feature-flags";

export const SHOP_STAFF_ROLES_FLAG = "shop_staff_roles_enabled" as const;

export async function shopStaffRolesEnabled(): Promise<boolean> {
  return isFeatureEnabled(SHOP_STAFF_ROLES_FLAG);
}

export interface StaffGrant {
  staffId: string;
  role: ShopStaffRole;
  permissions: ShopStaffPermission[];
}

/** The user's ACTIVE staff row in this shop, with its effective permissions; null otherwise (INVITED, SUSPENDED, REVOKED or none). */
export async function activeStaffGrant(shopId: string, userId: string, client: DbClient = db): Promise<StaffGrant | null> {
  const [row] = await client
    .select({ id: shopStaff.id, role: shopStaff.role, permissions: shopStaff.permissions })
    .from(shopStaff)
    .where(and(eq(shopStaff.shopId, shopId), eq(shopStaff.userId, userId), eq(shopStaff.status, "ACTIVE")));
  if (!row) return null;
  const role = isShopStaffRole(row.role) ? row.role : LEGACY_CATALOGUE_ROLE;
  return { staffId: row.id, role, permissions: effectivePermissions(role, row.permissions) };
}

export type ShopPermissionVia = "OWNER" | "STAFF";

/**
 * Whether `actor` may use `permission` in this shop as its owner or as active
 * staff. Operators and administrators are not decided here — the guard
 * (`requireShopPermission`) adds their override exactly as `requireShopAccess` does.
 */
export async function shopStaffAccess(
  shopId: string,
  actor: { id: string },
  permission: ShopStaffPermission,
  client: DbClient = db,
): Promise<{ via: ShopPermissionVia; grant: StaffGrant | null } | null> {
  const [shop] = await client
    .select({ ownerId: shops.ownerId })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) return null;
  if (shop.ownerId === actor.id) return { via: "OWNER", grant: null };
  if (!(await shopStaffRolesEnabled())) return null;
  const grant = await activeStaffGrant(shopId, actor.id, client);
  if (!grant || !permissionAllows(grant.permissions, permission)) return null;
  return { via: "STAFF", grant };
}

export async function shopStaffCan(
  shopId: string,
  actor: { id: string },
  permission: ShopStaffPermission,
  client: DbClient = db,
): Promise<boolean> {
  return (await shopStaffAccess(shopId, actor, permission, client)) !== null;
}
