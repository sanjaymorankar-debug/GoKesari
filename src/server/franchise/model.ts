/**
 * Which commission model a shop falls under (final brief 21-Nov-2026 §3, §6, §7) — small and import-free of the
 * dealer modules so the dealer code can call it without a cycle.
 *
 *   Model B: the shop's dealer (its code's top person) holds an active franchise in the shop's zone at the time.
 *   Model A: everything else — including a franchise owner's shop outside his paid zones, and a free team's shop
 *            inside someone else's paid zone (that shop still attaches to the zone's franchise for recurring).
 */
import { and, eq, gt, inArray, lte, or, isNull, sql } from "drizzle-orm";

import { db, type DbClient } from "@/server/db";
import { franchiseAllocations, franchiseShopAreaPeriods, type FranchiseAllocation } from "@/server/db/schema";

/** The shop's zone at `at` (from its area), or null. */
export async function shopZoneAt(client: DbClient, shopId: string, at: Date): Promise<string | null> {
  const [p] = await client
    .select({ zoneId: franchiseShopAreaPeriods.zoneId })
    .from(franchiseShopAreaPeriods)
    .where(and(eq(franchiseShopAreaPeriods.shopId, shopId), lte(franchiseShopAreaPeriods.validFrom, at), or(isNull(franchiseShopAreaPeriods.validTo), gt(franchiseShopAreaPeriods.validTo, at))))
    .orderBy(sql`${franchiseShopAreaPeriods.validFrom} desc`)
    .limit(1);
  return p?.zoneId ?? null;
}

/** The dealer's active franchise in the shop's zone at `at` (Model B), or null (Model A). */
export async function franchiseModelFor(client: DbClient, dealerId: string, shopId: string, at: Date = new Date()): Promise<FranchiseAllocation | null> {
  const zoneId = await shopZoneAt(client, shopId, at);
  if (!zoneId) return null;
  const [a] = await client
    .select()
    .from(franchiseAllocations)
    .where(and(eq(franchiseAllocations.ownerDealerId, dealerId), eq(franchiseAllocations.zoneId, zoneId), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"]), eq(franchiseAllocations.isTest, false), lte(franchiseAllocations.activatedAt, at), gt(franchiseAllocations.expiresAt, at)))
    .limit(1);
  if (a) return a;
  // The hidden QA test zone (admin end-to-end check) counts too.
  const [t] = await client
    .select()
    .from(franchiseAllocations)
    .where(and(eq(franchiseAllocations.ownerDealerId, dealerId), eq(franchiseAllocations.zoneId, zoneId), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"]), eq(franchiseAllocations.isTest, true), gt(franchiseAllocations.expiresAt, at)))
    .limit(1);
  return t ?? null;
}

/** Whether the dealer holds any active franchise now (its shops earn even where the free programme is off). */
export async function hasActiveFranchise(client: DbClient, dealerId: string, at: Date = new Date()): Promise<boolean> {
  const [a] = await client
    .select({ id: franchiseAllocations.id })
    .from(franchiseAllocations)
    .where(and(eq(franchiseAllocations.ownerDealerId, dealerId), inArray(franchiseAllocations.status, ["ACTIVE", "SUSPENDED"]), gt(franchiseAllocations.expiresAt, at)))
    .limit(1);
  return !!a;
}

export const franchiseModelForDefault = (dealerId: string, shopId: string, at?: Date) => franchiseModelFor(db, dealerId, shopId, at);
