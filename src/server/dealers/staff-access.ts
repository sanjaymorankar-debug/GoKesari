/**
 * Dealership & Franchise Platform phase 6 (owner brief 23-Nov-2026, decision D9; docs/dealer-platform/): who may do
 * what on the dealer platform. ADMIN may do everything (as before); the dealership staff roles (0181) get the
 * permissions src/server/authz/permissions.ts gives them. A Regional Admin acts only on dealers in his own states /
 * districts (staff_region_scopes).
 */
import { eq } from "drizzle-orm";

import { stateCodeFromName } from "@/lib/indian-states";
import { forbidden } from "@/lib/errors";
import { can, PERMISSIONS, type Permission } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { dealerTerritories, staffRegionScopes, type Dealer, type UserRole } from "@/server/db/schema";

export interface StaffActor {
  id: string;
  role: UserRole;
}

/** ADMIN always; otherwise the role's permission. */
export function mayDo(role: UserRole, permission: Permission): boolean {
  return role === "ADMIN" || can(role, permission);
}

export function requireDealerPermission(actor: StaffActor, permission: Permission, what: string): void {
  if (!mayDo(actor.role, permission)) throw forbidden(`You may not ${what}.`);
}

/** May the user open the dealer platform's staff screens (read)? Admin, operator, and the dealership roles. */
export function isDealerStaff(role: UserRole): boolean {
  return role === "ADMIN" || role === "OPERATOR" || can(role, PERMISSIONS.DEALER_PLATFORM_VIEW);
}

/** The area codes (states "MH" / districts "MH-PUN") a Regional Admin works in; null for everyone else (no limit). */
export async function regionScope(actor: StaffActor): Promise<string[] | null> {
  if (actor.role !== "REGIONAL_ADMIN") return null;
  const [row] = await db.select({ codes: staffRegionScopes.areaCodes }).from(staffRegionScopes).where(eq(staffRegionScopes.userId, actor.id));
  return row?.codes ?? [];
}

/** True when the dealer is inside the codes: his state, or one of his working districts / areas. */
export async function dealerInRegion(dealer: Pick<Dealer, "id" | "state">, codes: readonly string[]): Promise<boolean> {
  const state = stateCodeFromName(dealer.state);
  if (state && codes.includes(state)) return true;
  const areas = await db.select({ code: dealerTerritories.areaCode }).from(dealerTerritories).where(eq(dealerTerritories.dealerId, dealer.id));
  return areas.some((a) => codes.some((c) => a.code === c || a.code.startsWith(`${c}-`)));
}

/** Throws unless the actor may act on this dealer (always, except a Regional Admin outside his regions). */
export async function requireDealerInScope(actor: StaffActor, dealer: Pick<Dealer, "id" | "state">): Promise<void> {
  const codes = await regionScope(actor);
  if (codes && !(await dealerInRegion(dealer, codes))) throw forbidden("This dealer is outside your regions.");
}

/** ADMIN only: sets a Regional Admin's states / districts. */
export async function setRegionScope(actor: StaffActor, userId: string, codes: string[]): Promise<void> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can set a Regional Admin's regions.");
  const clean = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}(-[A-Z0-9-]{1,20})?$/.test(c)))].slice(0, 100);
  await db.insert(staffRegionScopes).values({ userId, areaCodes: clean, updatedBy: actor.id }).onConflictDoUpdate({ target: staffRegionScopes.userId, set: { areaCodes: clean, updatedBy: actor.id, updatedAt: new Date() } });
}
