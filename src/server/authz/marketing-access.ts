/**
 * Access to a shop's marketing (GS-052/053). The owner — acting in a role
 * that holds MARKETING_MANAGE_OWN — may view and change it; operations
 * (MARKETING_APPROVE) may only view it.
 */
import { forbidden } from "@/lib/errors";
import { requireShopAccess } from "./guards";
import { can, PERMISSIONS } from "./permissions";

export async function requireShopMarketing(shopId: string, mode: "view" | "manage") {
  const { user, isPrivileged } = await requireShopAccess(shopId, { anyPermission: PERMISSIONS.MARKETING_APPROVE });
  if (isPrivileged) {
    if (mode === "manage") throw forbidden("Only the shop owner can change its campaigns.");
    return user;
  }
  if (!can(user.role, PERMISSIONS.MARKETING_MANAGE_OWN)) {
    throw forbidden("Switch to your shop role to manage marketing.");
  }
  return user;
}
