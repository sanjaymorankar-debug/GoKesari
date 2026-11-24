/**
 * Module 10 (docs/shop-staff-roles-2026-11): the shop guard that also lets in
 * the shop's staff, by permission.
 *
 * `requireShopPermission(shopId, permission, { anyPermission })` passes, in order:
 *   1. the shop's owner                                   (isPrivileged false, via OWNER)
 *   2. a role holding `anyPermission` (operators/admins)  (isPrivileged true,  via SUPPORT)
 *      — exactly as `requireShopAccess` does;
 *   3. with flag shop_staff_roles_enabled ON only: an ACTIVE staff member of
 *      this shop whose role grants `permission` (and its financial / config
 *      flag)                                              (isPrivileged false, via STAFF)
 * Everyone else is refused (403) and the refusal is logged, as requireShopAccess does.
 *
 * With the flag OFF this is requireShopAccess, unchanged. A staff action that
 * changes something is written to the audit log against the shop
 * (SHOP_STAFF_ACTION), which the owner's per-staff activity view reads.
 */
import { and, eq, isNull } from "drizzle-orm";

import { forbidden, notFound } from "@/lib/errors";
import type { ShopStaffPermission } from "@/lib/shop-staff/permissions";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { activeStaffGrant, shopStaffRolesEnabled, type StaffGrant } from "@/server/services/shop-staff-access";
import { permissionAllows } from "@/lib/shop-staff/permissions";
import { logDenied, requireUser, type AuthenticatedUser } from "./guards";
import { can, type Permission } from "./permissions";

export type ShopAccessVia = "OWNER" | "SUPPORT" | "STAFF";

export interface ShopPermissionAccess {
  user: AuthenticatedUser;
  isPrivileged: boolean;
  via: ShopAccessVia;
  /** Set when via is STAFF. */
  staff: StaffGrant | null;
}

/**
 * `permission` may be a list: any one of them lets a staff member in (a route
 * that then decides per action uses `assertStaffAllows`).
 */
export async function requireShopPermission(
  shopId: string,
  permission: ShopStaffPermission | readonly ShopStaffPermission[],
  options: { anyPermission: Permission },
): Promise<ShopPermissionAccess> {
  const wanted: readonly ShopStaffPermission[] = typeof permission === "string" ? [permission] : permission;
  const user = await requireUser();
  const shop = await db.query.shops.findFirst({
    where: and(eq(shops.id, shopId), isNull(shops.deletedAt)),
    columns: { id: true, ownerId: true },
  });
  if (!shop) throw notFound("Shop");

  if (shop.ownerId === user.id) return { user, isPrivileged: false, via: "OWNER", staff: null };
  if (can(user.role, options.anyPermission)) return { user, isPrivileged: true, via: "SUPPORT", staff: null };

  if (await shopStaffRolesEnabled()) {
    const grant = await activeStaffGrant(shopId, user.id);
    if (grant) {
      const held = wanted.find((p) => permissionAllows(grant.permissions, p));
      if (held) {
        if (!held.endsWith(".view")) {
          void recordAudit({
            actorId: user.id,
            actorRole: user.role,
            action: AUDIT_ACTIONS.SHOP_STAFF_ACTION,
            entityType: "shop",
            entityId: shopId,
            newValue: { permission: held, staffId: grant.staffId, role: grant.role },
          });
        }
        return { user, isPrivileged: false, via: "STAFF", staff: grant };
      }
      logDenied(user, `${wanted.join("|")}@shop:${shopId}`, "shop");
      throw forbidden("Your role in this shop does not allow this.");
    }
  }
  logDenied(user, `${options.anyPermission}@shop:${shopId}`, "shop");
  throw forbidden("This shop does not belong to you.");
}

/** After `requireShopPermission` with a list: a staff member must also hold this one (owner and operations pass). */
export function assertStaffAllows(access: Pick<ShopPermissionAccess, "via" | "staff" | "user">, permission: ShopStaffPermission): void {
  if (access.via !== "STAFF") return;
  if (access.staff && permissionAllows(access.staff.permissions, permission)) return;
  logDenied(access.user, `${permission}@staff`, "shop");
  throw forbidden("Your role in this shop does not allow this.");
}
