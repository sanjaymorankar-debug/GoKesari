/**
 * Franchise codes (owner's final brief 21-Nov-2026 §2, §4.2). Every person keeps his own code; the code used at
 * registration decides who registered the shop, and the shop's AREA decides its zone. Each franchise (allocation)
 * also gets a franchise code GKF-xxxxxx: an alias of the owner's own code (the owner registered the shop), closed for
 * new shops when the franchise expires. A free dealer's or a team member's code is never blocked by zone: a shop
 * outside the dealer's paid zones simply follows Model A (§7).
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatIst } from "@/lib/franchise";
import { db, type DbClient } from "@/server/db";
import { dealers, franchiseAllocations, franchiseCodes, referralCodes, type FranchiseAllocation, type FranchiseCode, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { prefixedCode } from "./prefixed-code";

interface Actor {
  id: string;
  role: UserRole;
}

const CODE_ATTEMPTS = 8;

/** The franchise code of a franchise, issued once when it is first activated (a renewal keeps it). */
export async function ensureAllocationCode(tx: DbClient, allocation: Pick<FranchiseAllocation, "id" | "ownerDealerId" | "zoneId">, actor: Actor | null = null): Promise<string> {
  const [existing] = await tx.select({ code: referralCodes.code }).from(franchiseCodes).innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId)).where(eq(franchiseCodes.allocationId, allocation.id));
  if (existing) return existing.code;
  const [owner] = await tx.select().from(dealers).where(eq(dealers.id, allocation.ownerDealerId));
  if (!owner) throw notFound("Dealer");
  const createdBy = actor?.id ?? owner.userId;
  if (!createdBy) throw conflict("The franchise owner has no GoKesari account.");
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const code = prefixedCode("GKF");
    const id = await tx
      .transaction(async (sp) => {
        const [row] = await sp.insert(referralCodes).values({ code, label: `Franchise ${allocation.zoneId}: ${owner.legalName}`, referrerName: owner.legalName, referrerUserId: owner.userId, status: "ACTIVE", createdBy }).returning({ id: referralCodes.id });
        return row.id;
      })
      .catch((e: unknown) => {
        if (/referral_codes_code_unique|23505/.test(String((e as Error)?.message ?? "")) || (e as { code?: string })?.code === "23505") return null;
        throw e;
      });
    if (!id) continue;
    await tx.insert(franchiseCodes).values({ referralCodeId: id, ownerDealerId: owner.id, allocationId: allocation.id, status: "ACTIVE" });
    await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_CODE_CHANGED, entityType: "dealer", entityId: owner.id, actorId: createdBy, newValue: { issued: code, allocationId: allocation.id, zoneId: allocation.zoneId } }, tx);
    return code;
  }
  throw conflict("Could not generate a unique franchise code. Please try again.");
}

/** At expiry, termination or refund (§4.2): the franchise code stops taking new shops. */
export async function closeAllocationCodes(tx: DbClient, allocation: Pick<FranchiseAllocation, "id">, now: Date): Promise<number> {
  const rows = await tx.select().from(franchiseCodes).where(and(eq(franchiseCodes.allocationId, allocation.id), eq(franchiseCodes.status, "ACTIVE")));
  if (!rows.length) return 0;
  await tx.update(franchiseCodes).set({ status: "SUSPENDED", updatedAt: now }).where(inArray(franchiseCodes.id, rows.map((r) => r.id)));
  await tx.update(referralCodes).set({ status: "INACTIVE" }).where(inArray(referralCodes.id, rows.map((r) => r.referralCodeId)));
  await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_CODE_CHANGED, entityType: "franchise_allocation", entityId: allocation.id, newValue: { closed: rows.length, reason: "franchise ended" } }, tx);
  return rows.length;
}

/** The franchise code behind a referral code (any status), or null for an ordinary code. */
export async function franchiseCodeFor(referralCodeId: string, client: DbClient = db): Promise<FranchiseCode | null> {
  const [row] = await client.select().from(franchiseCodes).where(eq(franchiseCodes.referralCodeId, referralCodeId));
  return row ?? null;
}

/**
 * Registration check for a typed code: a franchise code whose franchise has ended is refused with a clear message
 * (§4.2: "franchise code closed for new shops at expiry"). Any other code passes; the zone comes from the area.
 */
export async function assertFranchiseCodeOpen(codeText: string | null | undefined, client: DbClient = db): Promise<void> {
  if (!codeText?.trim()) return;
  const [fc] = await client
    .select({ fc: franchiseCodes, a: franchiseAllocations })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .innerJoin(franchiseAllocations, eq(franchiseAllocations.id, franchiseCodes.allocationId))
    .where(sql`upper(${referralCodes.code}) = upper(${codeText.trim()})`);
  if (!fc) return;
  if (fc.a.status === "EXPIRED") throw validationFailed(`This franchise code closed when the franchise in zone ${fc.a.zoneId} expired on ${formatIst(fc.a.expiresAt)}.`, { reason: "FRANCHISE_AREA_EXPIRED", fields: { referralCode: "Franchise expired." } });
  if (fc.fc.status !== "ACTIVE" || !["ACTIVE", "SUSPENDED"].includes(fc.a.status)) throw validationFailed("This franchise code is closed for new shops.", { reason: "FRANCHISE_CODE_CLOSED", fields: { referralCode: "Code closed." } });
}

/** An owner's franchise codes for his page: one per franchise (with its zone). */
export async function ownerCodes(ownerDealerId: string, client: DbClient = db): Promise<{ code: string; allocationId: string; zoneId: string; status: string }[]> {
  return client
    .select({ code: referralCodes.code, allocationId: franchiseCodes.allocationId, zoneId: franchiseAllocations.zoneId, status: franchiseCodes.status })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .innerJoin(franchiseAllocations, eq(franchiseAllocations.id, franchiseCodes.allocationId))
    .where(eq(franchiseCodes.ownerDealerId, ownerDealerId));
}

export const expiredMessage = (zoneId: string, at: Date) => `Franchise in zone ${zoneId} expired on ${formatIst(at)}.`;
