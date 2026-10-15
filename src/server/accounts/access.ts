/**
 * Who may open a shop's books (docs/inventory-accounting-2026-10, Part 7).
 *
 * The shop's owner — and an administrator (SYSTEM_CONFIG, admins only) for
 * support. Operators, other owners and the shop's photo staff are refused.
 * Every service below takes the shop id from here and filters every query
 * by it, so no request can reach another shop's rows.
 */
import { requireShopAccess, type AuthenticatedUser } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listShopsForOwner } from "@/server/services/shops";

export interface AccountsActor {
  id: string;
  role: AuthenticatedUser["role"];
}

export async function requireAccountsAccess(shopId: string): Promise<{ user: AuthenticatedUser; isPrivileged: boolean }> {
  return requireShopAccess(shopId, { anyPermission: PERMISSIONS.SYSTEM_CONFIG });
}

/** The signed-in owner's shop (their first, as the rest of Seller Central does), or null. */
export async function ownerShop(userId: string) {
  const shops = await listShopsForOwner(userId);
  return shops[0] ?? null;
}
