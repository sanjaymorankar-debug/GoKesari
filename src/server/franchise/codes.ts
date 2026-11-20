/**
 * Franchise codes and shop attribution (brief §3.2, §7, §9.4).
 *
 * One GKF-xxxxxx code per owner (and, for tracking only, one per team member): an ordinary referral_codes row
 * linked here, so every registration path accepts it. A shop registered with it must lie inside one of the
 * owner's ACTIVE zones (its map location, never the PIN code alone: 411002 is in 8 zones). Outside → refused
 * (or, by setting, treated as a Model A direct shop). The shop is attributed to the owner's allocation for that
 * zone; a franchise code never creates a Model A attribution, so only the owner is paid (brief §2.8).
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatIst } from "@/lib/franchise";
import { db, type DbClient } from "@/server/db";
import {
  dealerSalespeople,
  dealers,
  franchiseAllocations,
  franchiseCodes,
  franchiseShopAttributionHistory,
  franchiseShopAttributions,
  referralCodes,
  shops,
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

/** Issues the owner's GKF code (once) inside `tx`. member: a team member's tracking code. */
export async function ensureOwnerCode(tx: DbClient, ownerDealerId: string, memberId: string | null, actor: Actor | null = null): Promise<string> {
  const existing = await tx
    .select({ code: referralCodes.code })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .where(and(eq(franchiseCodes.ownerDealerId, ownerDealerId), memberId ? eq(franchiseCodes.memberId, memberId) : isNull(franchiseCodes.memberId), inArray(franchiseCodes.status, ["ACTIVE", "SUSPENDED"])))
    .limit(1);
  if (existing[0]) return existing[0].code;
  const [owner] = await tx.select().from(dealers).where(eq(dealers.id, ownerDealerId));
  if (!owner) throw notFound("Dealer");
  const member = memberId ? (await tx.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.id, memberId), eq(dealerSalespeople.dealerId, ownerDealerId))))[0] : null;
  if (memberId && !member) throw notFound("Team member");
  if (!actor?.id && !owner.userId) throw conflict("The franchise owner has no GoKesari account.");
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const code = prefixedCode("GKF");
    const id = await tx
      .transaction(async (sp) => {
        const [row] = await sp
          .insert(referralCodes)
          .values({ code, label: `Franchise: ${owner.legalName}${member ? ` — ${member.name} (${member.employeeId})` : ""}`, referrerName: member?.name ?? owner.legalName, referrerUserId: member?.userId ?? owner.userId, status: "ACTIVE", createdBy: (actor?.id ?? owner.userId)! })
          .returning({ id: referralCodes.id });
        return row.id;
      })
      .catch((e: unknown) => {
        if (/referral_codes_code_unique|23505/.test(String((e as Error)?.message ?? "")) || (e as { code?: string })?.code === "23505") return null;
        throw e;
      });
    if (!id) continue;
    await tx.insert(franchiseCodes).values({ referralCodeId: id, ownerDealerId, memberId: memberId ?? null, status: "ACTIVE" });
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_CODE_CHANGED, entityType: "dealer", entityId: ownerDealerId, newValue: { issued: code, memberId } }, tx);
    return code;
  }
  throw conflict("Could not generate a unique franchise code. Please try again.");
}

/** The owner has an active area again: his codes work again (they were closed when his last area ended). */
export async function reopenOwnerCodes(tx: DbClient, ownerDealerId: string): Promise<void> {
  const rows = await tx.select().from(franchiseCodes).where(and(eq(franchiseCodes.ownerDealerId, ownerDealerId), eq(franchiseCodes.status, "SUSPENDED")));
  if (!rows.length) return;
  await tx.update(franchiseCodes).set({ status: "ACTIVE", updatedAt: new Date() }).where(inArray(franchiseCodes.id, rows.map((r) => r.id)));
  await tx.update(referralCodes).set({ status: "ACTIVE" }).where(inArray(referralCodes.id, rows.map((r) => r.referralCodeId)));
}

/** No active area left (brief §9.4 step 3): the owner's and his team's franchise codes stop for new shops. */
export async function closeOwnerCodesIfNoArea(tx: DbClient, ownerDealerId: string, now: Date): Promise<boolean> {
  const [active] = await tx
    .select({ id: franchiseAllocations.id })
    .from(franchiseAllocations)
    .where(and(eq(franchiseAllocations.ownerDealerId, ownerDealerId), eq(franchiseAllocations.status, "ACTIVE"), sql`${franchiseAllocations.expiresAt} >= ${now.toISOString()}::timestamptz`))
    .limit(1);
  if (active) return false;
  const rows = await tx.select().from(franchiseCodes).where(and(eq(franchiseCodes.ownerDealerId, ownerDealerId), eq(franchiseCodes.status, "ACTIVE")));
  if (!rows.length) return false;
  await tx.update(franchiseCodes).set({ status: "SUSPENDED", updatedAt: now }).where(inArray(franchiseCodes.id, rows.map((r) => r.id)));
  await tx.update(referralCodes).set({ status: "INACTIVE" }).where(inArray(referralCodes.id, rows.map((r) => r.referralCodeId)));
  await recordAudit({ action: AUDIT_ACTIONS.FRANCHISE_CODE_CHANGED, entityType: "dealer", entityId: ownerDealerId, newValue: { closed: rows.length, reason: "no active franchise area" } }, tx);
  return true;
}

/** The franchise code behind a referral code (any status), or null for an ordinary code. */
export async function franchiseCodeFor(referralCodeId: string, client: DbClient = db): Promise<FranchiseCode | null> {
  const [row] = await client.select().from(franchiseCodes).where(eq(franchiseCodes.referralCodeId, referralCodeId));
  return row ?? null;
}

async function franchiseCodeByText(codeText: string, client: DbClient): Promise<FranchiseCode | null> {
  const [row] = await client
    .select({ fc: franchiseCodes })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .where(eq(referralCodes.code, codeText.trim().toUpperCase()));
  return row?.fc ?? null;
}

/** The owner's allocations that can take a shop at `point` now: ACTIVE, not expired, zone containing the point. */
async function ownerAllocationAt(client: DbClient, ownerDealerId: string, lat: number, lng: number, now: Date) {
  const zones = await zonesContaining(lat, lng, client);
  if (!zones.length) return { allocation: null, zones, expiredHere: false };
  const rows = await client.select().from(franchiseAllocations).where(and(eq(franchiseAllocations.ownerDealerId, ownerDealerId), inArray(franchiseAllocations.zoneId, zones)));
  const allocation = rows.find((a) => a.status === "ACTIVE" && a.expiresAt && a.expiresAt.getTime() >= now.getTime()) ?? null;
  const expiredHere = !allocation && rows.some((a) => a.status === "EXPIRED" || (a.status === "ACTIVE" && a.expiresAt && a.expiresAt.getTime() < now.getTime()));
  return { allocation, zones, expiredHere };
}

export type CodeLocationDecision = { kind: "NOT_FRANCHISE" } | { kind: "FRANCHISE"; allocationId: string; zoneId: string } | { kind: "MODEL_A_DIRECT" };

/**
 * Brief §3.2 / §9.4: may a shop at (lat, lng) register with `codeText`? Throws a clear error when not.
 * Ordinary dealer codes pass unless the setting blocks free dealers in franchised zones (default: allow).
 * Location missing: a franchise code is refused until the shop's map pin is set.
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
        if (taken) throw validationFailed("This shop is inside a franchise area; please register it with the area franchise's code.", { reason: "FRANCHISED_ZONE", fields: { referralCode: "Use the area franchise's code." } });
      }
    }
    return { kind: "NOT_FRANCHISE" };
  }
  if (fc.status !== "ACTIVE") throw validationFailed("This franchise code is closed for new shops (no active franchise area).", { reason: "FRANCHISE_CODE_CLOSED", fields: { referralCode: "Code closed." } });
  if (!hasPoint) throw validationFailed("Set the shop's location on the map: a franchise code works only inside the franchise's areas.", { reason: "FRANCHISE_NEEDS_LOCATION", fields: { referralCode: "Needs the map location." } });
  const at = await ownerAllocationAt(client, fc.ownerDealerId, la, ln, now);
  if (at.allocation) return { kind: "FRANCHISE", allocationId: at.allocation.id, zoneId: at.allocation.zoneId };
  if (at.expiredHere) throw validationFailed("This franchise area has expired.", { reason: "FRANCHISE_AREA_EXPIRED", fields: { referralCode: "Area expired." } });
  if (config.franchiseCodeOutsideZone === "treat_as_model_A_direct_20") return { kind: "MODEL_A_DIRECT" };
  throw validationFailed("This shop is outside the franchise's areas, so this franchise code cannot be used for it.", { reason: "FRANCHISE_OUTSIDE_ZONE", fields: { referralCode: "Outside the franchise's areas." } });
}

/**
 * Called by the dealer attribution (attribution.ts) for a shop whose code is a franchise code: records the
 * franchise attribution and returns true (no Model A attribution is made). False: not a franchise code, or
 * the outside-zone setting sends it to Model A.
 */
export async function recordFranchiseAttribution(shopId: string, referralCodeId: string, actor: Actor | null): Promise<boolean> {
  const fc = await franchiseCodeFor(referralCodeId);
  if (!fc) return false;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return true;
  const [existing] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shopId));
  if (existing) return true;
  const { config } = await franchiseConfig();
  const now = franchiseNow(config);
  const la = Number(shop.latitude);
  const ln = Number(shop.longitude);
  const at = Number.isFinite(la) && Number.isFinite(ln) && shop.latitude && shop.longitude ? await ownerAllocationAt(db, fc.ownerDealerId, la, ln, now) : { allocation: null, zones: [] as string[], expiredHere: false };
  if (!at.allocation) {
    if (config.franchiseCodeOutsideZone === "treat_as_model_A_direct_20") return false;
    // Registered before the check (or the area ended in between): kept for an admin decision, never paid automatically.
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "shop", entityId: shopId, newValue: { problem: "franchise_code_outside_active_zone", ownerDealerId: fc.ownerDealerId, zones: at.zones } });
    return true;
  }
  const allocation = at.allocation;
  await db.transaction(async (tx) => {
    const row = { shopId, ownerDealerId: fc.ownerDealerId, allocationId: allocation.id, zoneId: allocation.zoneId, franchiseCodeId: fc.id, memberId: fc.memberId, status: "ACTIVE" as const };
    const inserted = await tx.insert(franchiseShopAttributions).values(row).onConflictDoNothing().returning();
    if (!inserted.length) return;
    await tx.insert(franchiseShopAttributionHistory).values({ shopId, before: null, after: row, reason: "registered with a franchise code", changedBy: actor?.id ?? null });
    await recordAudit({ actorId: actor?.id ?? null, actorRole: actor?.role ?? null, action: AUDIT_ACTIONS.FRANCHISE_ATTRIBUTION_CHANGED, entityType: "shop", entityId: shopId, newValue: row }, tx);
  });
  const [owner] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, fc.ownerDealerId));
  if (owner?.userId) {
    await notify({ userId: owner.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title: "New shop in your franchise area", message: `${shop.name} registered in zone ${allocation.zoneId} with your franchise code.` }, actionUrl: "/franchise/my", channels: ["PUSH"], dedupeKey: `franchise-shop:${shopId}` }).catch(() => {});
  }
  return true;
}

/** "allow_and_notify_franchise" (brief §7): the zone's owners hear about a shop another dealer registered there. */
export async function notifyFranchiseOfOtherDealerShop(shopId: string): Promise<void> {
  const { config } = await franchiseConfig();
  if (config.freeDealerInFranchisedZone !== "allow_and_notify_franchise") return;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop?.latitude || !shop.longitude) return;
  const zones = await zonesContaining(Number(shop.latitude), Number(shop.longitude));
  if (!zones.length) return;
  const owners = await db
    .selectDistinct({ userId: dealers.userId })
    .from(franchiseAllocations)
    .innerJoin(dealers, eq(dealers.id, franchiseAllocations.ownerDealerId))
    .where(and(inArray(franchiseAllocations.zoneId, zones), eq(franchiseAllocations.status, "ACTIVE")));
  for (const o of owners) {
    if (!o.userId) continue;
    await notify({ userId: o.userId, type: NOTIFICATION_TYPES.FRANCHISE_NOTICE, vars: { title: "A shop joined in your area", message: `${shop.name} registered in your franchise area with another dealer's code (no franchise commission on it).` }, actionUrl: "/franchise/my", dedupeKey: `franchise-other-shop:${shopId}:${o.userId}` }).catch(() => {});
  }
}

/** The owner issues a tracking-only franchise code to a member of his own team (brief §2.8). */
export async function issueMemberFranchiseCode(actor: Actor, memberId: string): Promise<string> {
  const [owner] = await db.select().from(dealers).where(eq(dealers.userId, actor.id));
  if (!owner) throw forbidden("Only a franchise owner can do this.");
  const [hasArea] = await db.select({ id: franchiseAllocations.id }).from(franchiseAllocations).where(and(eq(franchiseAllocations.ownerDealerId, owner.id), eq(franchiseAllocations.status, "ACTIVE"))).limit(1);
  if (!hasArea) throw conflict("You need an active franchise area first.");
  const [member] = await db.select().from(dealerSalespeople).where(and(eq(dealerSalespeople.id, memberId), eq(dealerSalespeople.dealerId, owner.id)));
  if (!member || member.status !== "ACTIVE") throw notFound("Team member");
  return db.transaction((tx) => ensureOwnerCode(tx, owner.id, memberId, actor));
}

/** Codes of an owner for his page: his own and his members' (tracking only). */
export async function ownerCodes(ownerDealerId: string, client: DbClient = db): Promise<{ code: string; memberId: string | null; memberName: string | null; status: string }[]> {
  const rows = await client
    .select({ code: referralCodes.code, memberId: franchiseCodes.memberId, status: franchiseCodes.status, memberName: dealerSalespeople.name })
    .from(franchiseCodes)
    .innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId))
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, franchiseCodes.memberId))
    .where(eq(franchiseCodes.ownerDealerId, ownerDealerId));
  return rows.map((r) => ({ ...r, memberName: r.memberName ?? null }));
}

export const expiredMessage = (zoneId: string, at: Date) => `Franchise area ${zoneId} expired on ${formatIst(at)}.`;
