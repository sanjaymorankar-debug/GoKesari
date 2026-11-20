/**
 * Dealer codes and shop tagging for paid franchise areas (brief 20-Nov §3.2, §7, §9.4; brief 21-Nov §1).
 *
 * Each booked area (allocation) has its own dealer code GKF-xxxxxx — one code per dealer per area. A shop that
 * registers with it must lie inside that area (its map location within 5 km of the area's centre / inside its
 * approved boundary); outside, registration is blocked with a clear message, and only an admin can tag it anyway
 * (logged). The shop is then tagged permanently to dealer + area + code, and all commission and bonus is
 * worked out from that tag. A team member's tracking code (no area of its own) counts for whichever of the
 * owner's active areas contains the shop. A franchise code never creates a Model A attribution.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { boundaryContains, formatIst, type LatLng } from "@/lib/franchise";
import { db, type DbClient } from "@/server/db";
import {
  dealerSalespeople,
  dealers,
  franchiseAllocations,
  franchiseCodes,
  franchiseShopAttributionHistory,
  franchiseShopAttributions,
  franchiseZoneBoundaries,
  referralCodes,
  shops,
  type FranchiseAllocation,
  type FranchiseCode,
  type UserRole,
} from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { franchiseConfig, franchiseNow } from "./config";
import { prefixedCode } from "./prefixed-code";
import { zonesContaining } from "./zones";

interface Actor {
  id: string;
  role: UserRole;
}

const CODE_ATTEMPTS = 8;

async function insertCode(tx: DbClient, input: { ownerDealerId: string; allocationId: string | null; memberId: string | null; label: string; referrerName: string; referrerUserId: string | null; createdBy: string }): Promise<string> {
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const code = prefixedCode("GKF");
    const id = await tx
      .transaction(async (sp) => {
        const [row] = await sp.insert(referralCodes).values({ code, label: input.label, referrerName: input.referrerName, referrerUserId: input.referrerUserId, status: "ACTIVE", createdBy: input.createdBy }).returning({ id: referralCodes.id });
        return row.id;
      })
      .catch((e: unknown) => {
        if (/referral_codes_code_unique|23505/.test(String((e as Error)?.message ?? "")) || (e as { code?: string })?.code === "23505") return null;
        throw e;
      });
    if (!id) continue;
    await tx.insert(franchiseCodes).values({ referralCodeId: id, ownerDealerId: input.ownerDealerId, allocationId: input.allocationId, memberId: input.memberId, status: "ACTIVE" });
    await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_CODE_CHANGED, entityType: "dealer", entityId: input.ownerDealerId, actorId: input.createdBy, newValue: { issued: code, allocationId: input.allocationId, memberId: input.memberId } }, tx);
    return code;
  }
  throw conflict("Could not generate a unique dealer code. Please try again.");
}

/** The dealer code of a booked area, issued once when the area is first activated (renewal keeps it). */
export async function ensureAllocationCode(tx: DbClient, allocation: Pick<FranchiseAllocation, "id" | "ownerDealerId" | "zoneId">, actor: Actor | null = null): Promise<string> {
  const [existing] = await tx
    .select({ code: referralCodes.code })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .where(and(eq(franchiseCodes.allocationId, allocation.id), isNull(franchiseCodes.memberId)));
  if (existing) return existing.code;
  const [owner] = await tx.select().from(dealers).where(eq(dealers.id, allocation.ownerDealerId));
  if (!owner) throw notFound("Dealer");
  const createdBy = actor?.id ?? owner.userId;
  if (!createdBy) throw conflict("The franchise owner has no GoKesari account.");
  return insertCode(tx, { ownerDealerId: owner.id, allocationId: allocation.id, memberId: null, label: `Franchise ${allocation.zoneId}: ${owner.legalName}`, referrerName: owner.legalName, referrerUserId: owner.userId, createdBy });
}

/** At expiry or termination (brief 20-Nov §9.4): the area's code stops for new shops; members' codes stop when no area is left. */
export async function closeAllocationCodes(tx: DbClient, allocation: Pick<FranchiseAllocation, "id" | "ownerDealerId">, now: Date): Promise<number> {
  const own = await tx.select().from(franchiseCodes).where(and(eq(franchiseCodes.allocationId, allocation.id), eq(franchiseCodes.status, "ACTIVE")));
  let members: FranchiseCode[] = [];
  const [active] = await tx
    .select({ id: franchiseAllocations.id })
    .from(franchiseAllocations)
    .where(and(eq(franchiseAllocations.ownerDealerId, allocation.ownerDealerId), eq(franchiseAllocations.status, "ACTIVE"), sql`${franchiseAllocations.id} <> ${allocation.id}`, sql`${franchiseAllocations.expiresAt} >= ${now.toISOString()}::timestamptz`))
    .limit(1);
  if (!active) members = await tx.select().from(franchiseCodes).where(and(eq(franchiseCodes.ownerDealerId, allocation.ownerDealerId), isNull(franchiseCodes.allocationId), eq(franchiseCodes.status, "ACTIVE")));
  const rows = [...own, ...members];
  if (!rows.length) return 0;
  await tx.update(franchiseCodes).set({ status: "SUSPENDED", updatedAt: now }).where(inArray(franchiseCodes.id, rows.map((r) => r.id)));
  await tx.update(referralCodes).set({ status: "INACTIVE" }).where(inArray(referralCodes.id, rows.map((r) => r.referralCodeId)));
  await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_CODE_CHANGED, entityType: "franchise_allocation", entityId: allocation.id, newValue: { closed: rows.length, members: members.length, reason: "area ended" } }, tx);
  return rows.length;
}

/** The owner has an active area again: his team members' tracking codes work again. */
export async function reopenMemberCodes(tx: DbClient, ownerDealerId: string): Promise<void> {
  const rows = await tx.select().from(franchiseCodes).where(and(eq(franchiseCodes.ownerDealerId, ownerDealerId), isNull(franchiseCodes.allocationId), eq(franchiseCodes.status, "SUSPENDED")));
  if (!rows.length) return;
  await tx.update(franchiseCodes).set({ status: "ACTIVE", updatedAt: new Date() }).where(inArray(franchiseCodes.id, rows.map((r) => r.id)));
  await tx.update(referralCodes).set({ status: "ACTIVE" }).where(inArray(referralCodes.id, rows.map((r) => r.referralCodeId)));
}

/** The franchise code behind a referral code (any status), or null for an ordinary code. */
export async function franchiseCodeFor(referralCodeId: string, client: DbClient = db): Promise<FranchiseCode | null> {
  const [row] = await client.select().from(franchiseCodes).where(eq(franchiseCodes.referralCodeId, referralCodeId));
  return row ?? null;
}

async function franchiseCodeByText(codeText: string, client: DbClient): Promise<FranchiseCode | null> {
  const [row] = await client.select({ fc: franchiseCodes }).from(franchiseCodes).innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId)).where(eq(referralCodes.code, codeText.trim().toUpperCase()));
  return row?.fc ?? null;
}

/** Does the approved boundary of `zoneId` contain the point? */
async function zoneContains(client: DbClient, zoneId: string, p: LatLng): Promise<boolean> {
  const [b] = await client.select().from(franchiseZoneBoundaries).where(and(eq(franchiseZoneBoundaries.zoneId, zoneId), eq(franchiseZoneBoundaries.status, "APPROVED")));
  if (!b || b.shape === "NONE") return false;
  const center: LatLng | null = b.refLat != null && b.refLng != null ? [Number(b.refLat), Number(b.refLng)] : null;
  return boundaryContains({ shape: b.shape, polygon: b.polygon, center, radiusM: b.radiusM }, p);
}

const isLive = (a: FranchiseAllocation, now: Date) => a.status === "ACTIVE" && !!a.expiresAt && a.expiresAt.getTime() >= now.getTime();

type Resolution = { allocation: FranchiseAllocation | null; reason: "OK" | "OUTSIDE" | "EXPIRED" | "CLOSED" };

/** Which of the code's areas can take a shop at `p` now. */
async function resolveCodeArea(client: DbClient, fc: FranchiseCode, p: LatLng, now: Date): Promise<Resolution> {
  if (fc.allocationId) {
    const [a] = await client.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, fc.allocationId));
    if (!a) return { allocation: null, reason: "CLOSED" };
    const inside = await zoneContains(client, a.zoneId, p);
    if (!isLive(a, now)) return { allocation: null, reason: a.status === "EXPIRED" || a.status === "ACTIVE" ? "EXPIRED" : "CLOSED" };
    return inside ? { allocation: a, reason: "OK" } : { allocation: null, reason: "OUTSIDE" };
  }
  // A member's tracking code: the first of the owner's live areas that contains the shop.
  const rows = await client.select().from(franchiseAllocations).where(eq(franchiseAllocations.ownerDealerId, fc.ownerDealerId));
  let expiredHere = false;
  for (const a of rows) {
    if (!(await zoneContains(client, a.zoneId, p))) continue;
    if (isLive(a, now)) return { allocation: a, reason: "OK" };
    if (a.status === "EXPIRED") expiredHere = true;
  }
  return { allocation: null, reason: expiredHere ? "EXPIRED" : "OUTSIDE" };
}

export type CodeLocationDecision = { kind: "NOT_FRANCHISE" } | { kind: "FRANCHISE"; allocationId: string; zoneId: string } | { kind: "MODEL_A_DIRECT" };

/**
 * May a shop at (lat, lng) register with `codeText`? Throws a clear error when not (brief 21-Nov §1.5).
 * Ordinary dealer codes pass unless the setting blocks free dealers in franchised areas (default: allow).
 */
export async function assertCodeForLocation(codeText: string | null | undefined, lat: number | string | null | undefined, lng: number | string | null | undefined, client: DbClient = db): Promise<CodeLocationDecision> {
  if (!codeText || !codeText.trim()) return { kind: "NOT_FRANCHISE" };
  const fc = await franchiseCodeByText(codeText, client);
  const { config } = await franchiseConfig(client);
  const now = franchiseNow(config);
  const la = lat == null || lat === "" ? NaN : Number(lat);
  const ln = lng == null || lng === "" ? NaN : Number(lng);
  const hasPoint = Number.isFinite(la) && Number.isFinite(ln);
  if (!fc) {
    if (config.freeDealerInFranchisedZone === "block" && hasPoint) {
      const zones = await zonesContaining(la, ln, client);
      if (zones.length) {
        const [taken] = await client.select({ id: franchiseAllocations.id }).from(franchiseAllocations).where(and(inArray(franchiseAllocations.zoneId, zones), eq(franchiseAllocations.status, "ACTIVE"))).limit(1);
        if (taken) throw validationFailed("This shop is inside a franchise area; please register it with the area franchise's dealer code.", { reason: "FRANCHISED_ZONE", fields: { referralCode: "Use the area franchise's code." } });
      }
    }
    return { kind: "NOT_FRANCHISE" };
  }
  if (!hasPoint) throw validationFailed("Set the shop's location on the map first: a franchise dealer code works only for shops inside its area.", { reason: "FRANCHISE_NEEDS_LOCATION", fields: { referralCode: "Needs the map location." } });
  const r = await resolveCodeArea(client, fc, [la, ln], now);
  if (r.allocation && fc.status === "ACTIVE") return { kind: "FRANCHISE", allocationId: r.allocation.id, zoneId: r.allocation.zoneId };
  if (r.reason === "EXPIRED") throw validationFailed("This franchise area has expired.", { reason: "FRANCHISE_AREA_EXPIRED", fields: { referralCode: "Area expired." } });
  if (r.reason === "CLOSED" || fc.status !== "ACTIVE") throw validationFailed("This dealer code is closed for new shops.", { reason: "FRANCHISE_CODE_CLOSED", fields: { referralCode: "Code closed." } });
  if (config.franchiseCodeOutsideZone === "treat_as_model_A_direct_20") return { kind: "MODEL_A_DIRECT" };
  throw validationFailed("This shop is outside the dealer code's area (more than 5 km from its centre), so the code cannot be used for it. Ask GoKesari if you think this is wrong.", { reason: "FRANCHISE_OUTSIDE_ZONE", fields: { referralCode: "Outside the code's area." } });
}

async function writeTag(shopId: string, fc: FranchiseCode, allocation: FranchiseAllocation, actor: Actor | null, override: string | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = { shopId, ownerDealerId: fc.ownerDealerId, allocationId: allocation.id, zoneId: allocation.zoneId, franchiseCodeId: fc.id, memberId: fc.memberId, status: "ACTIVE" as const, overrideReason: override, overrideBy: override ? (actor?.id ?? null) : null };
    const inserted = await tx.insert(franchiseShopAttributions).values(row).onConflictDoNothing().returning();
    if (!inserted.length) return false;
    await tx.insert(franchiseShopAttributionHistory).values({ shopId, before: null, after: row, reason: override ? `admin override: ${override}` : "registered with a franchise dealer code", changedBy: actor?.id ?? null });
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "shop", entityId: shopId, newValue: { ...row, override: !!override } }, tx);
    return true;
  });
}

/**
 * Called by the dealer attribution (attribution.ts) for a shop registered with a franchise code: tags it to
 * dealer + area + code and returns true (no Model A attribution). False only when the outside-area setting sends
 * it to Model A.
 */
export async function recordFranchiseAttribution(shopId: string, referralCodeId: string, actor: Actor | null): Promise<boolean> {
  const fc = await franchiseCodeFor(referralCodeId);
  if (!fc) return false;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return true;
  const [existing] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  if (existing) return true;
  const { config } = await franchiseConfig();
  const la = Number(shop.latitude);
  const ln = Number(shop.longitude);
  const r = shop.latitude && shop.longitude && Number.isFinite(la) && Number.isFinite(ln) ? await resolveCodeArea(db, fc, [la, ln], franchiseNow(config)) : { allocation: null, reason: "OUTSIDE" as const };
  if (!r.allocation) {
    if (config.franchiseCodeOutsideZone === "treat_as_model_A_direct_20") return false;
    // Registered past the check (or the area ended in between): left for an admin, never paid automatically.
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "shop", entityId: shopId, newValue: { problem: "franchise_code_outside_area", reason: r.reason, codeId: fc.id } });
    return true;
  }
  if (await writeTag(shopId, fc, r.allocation, actor, null)) {
    const [owner] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, fc.ownerDealerId));
    if (owner?.userId) {
      await notify({ userId: owner.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title: "New shop with your dealer code", message: `${shop.name} registered in area ${r.allocation.zoneId}.` }, actionUrl: "/franchise/my", channels: ["PUSH"], dedupeKey: `franchise-shop:${shopId}` }).catch(() => {});
    }
  }
  return true;
}

/** Admin override (brief 21-Nov §1.5): tag a shop to a dealer code although it is outside the code's area. Logged. */
export async function adminTagShop(shopId: string, codeText: string, reason: string, actor: Actor): Promise<void> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can override the area check.");
  if (reason.trim().length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  const fc = await franchiseCodeByText(codeText, db);
  if (!fc) throw notFound("Dealer code");
  const [shop] = await db.select({ id: shops.id }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  const [existing] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  if (existing) throw conflict("This shop is already tagged to a franchise dealer code; tags are permanent.");
  const [a] = fc.allocationId
    ? await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, fc.allocationId))
    : await db.select().from(franchiseAllocations).where(and(eq(franchiseAllocations.ownerDealerId, fc.ownerDealerId), eq(franchiseAllocations.status, "ACTIVE"))).limit(1);
  if (!a || a.status !== "ACTIVE") throw conflict("The code's area is not active.");
  await writeTag(shopId, fc, a, actor, reason.trim().slice(0, 300));
}

/** "allow_and_notify_franchise" (brief 20-Nov §7): owners of areas containing the shop hear about another dealer's shop. */
export async function notifyFranchiseOfOtherDealerShop(shopId: string): Promise<void> {
  const { config } = await franchiseConfig();
  if (config.freeDealerInFranchisedZone !== "allow_and_notify_franchise") return;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop?.latitude || !shop.longitude) return;
  const zones = await zonesContaining(Number(shop.latitude), Number(shop.longitude));
  if (!zones.length) return;
  const owners = await db.selectDistinct({ userId: dealers.userId }).from(franchiseAllocations).innerJoin(dealers, eq(dealers.id, franchiseAllocations.ownerDealerId)).where(and(inArray(franchiseAllocations.zoneId, zones), eq(franchiseAllocations.status, "ACTIVE")));
  for (const o of owners) {
    if (!o.userId) continue;
    await notify({ userId: o.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title: "A shop joined in your area", message: `${shop.name} registered in your franchise area with another dealer's code (no franchise commission on it).` }, actionUrl: "/franchise/my", dedupeKey: `franchise-other-shop:${shopId}:${o.userId}` }).catch(() => {});
  }
}

/** The owner issues a tracking-only code to a member of his own team (brief 20-Nov §2.8). */
export async function issueMemberFranchiseCode(actor: Actor, memberId: string): Promise<string> {
  const [owner] = await db.select().from(dealers).where(eq(dealers.userId, actor.id));
  if (!owner) throw forbidden("Only a franchise owner can do this.");
  const [hasArea] = await db.select({ id: franchiseAllocations.id }).from(franchiseAllocations).where(and(eq(franchiseAllocations.ownerDealerId, owner.id), eq(franchiseAllocations.status, "ACTIVE"))).limit(1);
  if (!hasArea) throw conflict("You need an active franchise area first.");
  const [member] = await db.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.id, memberId), eq(dealerSalespeople.dealerId, owner.id)));
  if (!member || member.status !== "ACTIVE") throw notFound("Team member");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ code: referralCodes.code }).from(franchiseCodes).innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId)).where(and(eq(franchiseCodes.memberId, memberId), eq(franchiseCodes.status, "ACTIVE")));
    if (existing) return existing.code;
    return insertCode(tx, { ownerDealerId: owner.id, allocationId: null, memberId, label: `Franchise ${owner.legalName} — ${member.name} (${member.employeeId})`, referrerName: member.name, referrerUserId: member.userId, createdBy: actor.id });
  });
}

/** An owner's codes for his page: one per area (with its zone) and his members' tracking codes. */
export async function ownerCodes(ownerDealerId: string, client: DbClient = db): Promise<{ code: string; allocationId: string | null; zoneId: string | null; memberId: string | null; memberName: string | null; status: string }[]> {
  const rows = await client
    .select({ code: referralCodes.code, allocationId: franchiseCodes.allocationId, zoneId: franchiseAllocations.zoneId, memberId: franchiseCodes.memberId, status: franchiseCodes.status, memberName: dealerSalespeople.name })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, franchiseCodes.memberId))
    .leftJoin(franchiseAllocations, eq(franchiseAllocations.id, franchiseCodes.allocationId))
    .where(eq(franchiseCodes.ownerDealerId, ownerDealerId));
  return rows.map((r) => ({ ...r, zoneId: r.zoneId ?? null, memberName: r.memberName ?? null }));
}

export const expiredMessage = (zoneId: string, at: Date) => `Franchise area ${zoneId} expired on ${formatIst(at)}.`;
