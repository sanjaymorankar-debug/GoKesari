/**
 * Which dealer brought a shop (docs/dealer-programme, GKS-RA-001, GKS-SH-003).
 *
 * Attribution priority — decided once, after the shop is registered:
 *   1. a code entered or attached at registration (dealer code, employee code
 *      or a legacy code; dealer-assisted registrations attach the dealer's own);
 *   2. otherwise a valid, unexpired lead with the owner's consent whose mobile
 *      (or GSTIN) matches the shop — the EARLIEST such lead wins;
 *   3. otherwise no dealer.
 * Other dealers' open leads for the same shop are then closed with the reason,
 * and those dealers are told; a dealer who disagrees raises a claim
 * (disputes.ts), which staff decide. Attribution is never moved silently.
 *
 * The optional Employee ID / name typed at registration is matched to the
 * dealer's active employees (Employee ID first, then the exact name); no match
 * keeps the text for the dealer to see, attributed to the dealer alone.
 *
 * Duplicates: the new shop is compared with existing shops by mobile, GSTIN,
 * PAN and a similar name close by. Another owner's shop → DUPLICATE (no
 * new-shop commission); the same owner's other shop → BRANCH (commission per
 * the branch rule). Shops keep registering as before — this only marks the
 * attribution.
 *
 * Runs only while the dealer programme is on for the shop's district (from its
 * PIN code), and after the registration has committed: it never blocks or
 * changes a registration.
 */
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { haversineDistanceKm } from "@/lib/geo/haversine";
import { nameMatchScore } from "@/lib/kyc/name-match";
import { db, type DbClient } from "@/server/db";
import {
  dealerCodes,
  dealerLeads,
  dealers,
  dealerSalespeople,
  shopAttributions,
  shops,
  type AttributionSource,
  type Dealer,
  type ShopAttribution,
  type UserRole,
} from "@/server/db/schema";
import { isUniqueViolation } from "@/server/db/split/upsert";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { flagCoversDistrict, getFeatureFlag } from "@/server/services/feature-flags";
import { districtCodeForPincode } from "@/server/services/geo-areas";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { checkCommissionMilestonesSafely } from "./commission";

interface Actor {
  id: string;
  role: UserRole;
}

/** +91XXXXXXXXXX from anything with a 10-digit Indian mobile in it, else null. */
export function normalizeIndianMobile(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  const ten = digits.length >= 10 ? digits.slice(-10) : "";
  return /^[6-9][0-9]{9}$/.test(ten) ? `+91${ten}` : null;
}

/** The internal GoKesari Direct dealer (made by migration 0104; made here if missing). */
export async function directDealer(client: DbClient = db): Promise<Dealer> {
  const [found] = await client.select().from(dealers).where(eq(dealers.isInternal, true)).limit(1);
  if (found) return found;
  try {
    const [row] = await client
      .insert(dealers)
      .values({ legalName: "GoKesari Direct", contactName: "GoKesari", dealerType: "COMPANY", status: "APPROVED", isInternal: true, source: "ADMIN", decidedAt: new Date() })
      .returning();
    return row;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [row] = await client.select().from(dealers).where(eq(dealers.isInternal, true)).limit(1);
    return row;
  }
}

/* ------------------------------------------------------------ duplicates */

export interface DuplicateMatch {
  kind: "NONE" | "DUPLICATE" | "BRANCH";
  matchedShopId: string | null;
  reasons: string[];
}

/**
 * Existing shops that look like this one: same mobile, GSTIN or PAN, or a
 * similar name within duplicateDistanceMeters (or in the same PIN code when a
 * location is missing). Rejected and deleted shops do not count.
 */
export async function findLikelyDuplicate(shopId: string, client: DbClient = db): Promise<DuplicateMatch> {
  const [shop] = await client.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return { kind: "NONE", matchedShopId: null, reasons: [] };
  const rule = await getRule("dealerProgramme");
  const phone = normalizeIndianMobile(shop.phone);
  const tail = phone ? phone.slice(-10) : null;
  const candidates = await client
    .select({
      id: shops.id,
      ownerId: shops.ownerId,
      name: shops.name,
      phone: shops.phone,
      gstin: shops.gstin,
      panHash: shops.panHash,
      pincode: shops.pincode,
      latitude: shops.latitude,
      longitude: shops.longitude,
      createdAt: shops.createdAt,
    })
    .from(shops)
    .where(
      and(
        ne(shops.id, shop.id),
        isNull(shops.deletedAt),
        ne(shops.status, "REJECTED"),
        or(
          tail ? sql`right(regexp_replace(${shops.phone}, '\\D', '', 'g'), 10) = ${tail}` : sql`false`,
          shop.gstin ? eq(shops.gstin, shop.gstin) : sql`false`,
          shop.panHash ? eq(shops.panHash, shop.panHash) : sql`false`,
          eq(shops.pincode, shop.pincode),
        ),
      ),
    )
    .orderBy(asc(shops.createdAt))
    .limit(500);

  const point = (lat: string | null, lng: string | null) => {
    const a = Number(lat);
    const b = Number(lng);
    return lat && lng && Number.isFinite(a) && Number.isFinite(b) ? { latitude: a, longitude: b } : null;
  };
  const here = point(shop.latitude, shop.longitude);
  let best: { id: string; ownerId: string; reasons: string[] } | null = null;
  for (const c of candidates) {
    const reasons: string[] = [];
    if (tail && normalizeIndianMobile(c.phone) === phone) reasons.push("MOBILE");
    if (shop.gstin && c.gstin === shop.gstin) reasons.push("GSTIN");
    if (shop.panHash && c.panHash === shop.panHash) reasons.push("PAN");
    if (nameMatchScore(shop.name, c.name) >= rule.nameSimilarity) {
      const there = point(c.latitude, c.longitude);
      if (here && there) {
        if (haversineDistanceKm(here, there) * 1000 <= rule.duplicateDistanceMeters) reasons.push("NAME_NEARBY");
      } else if (c.pincode === shop.pincode) {
        reasons.push("NAME_SAME_PIN");
      }
    }
    if (reasons.length && (!best || reasons.length > best.reasons.length)) best = { id: c.id, ownerId: c.ownerId, reasons };
  }
  if (!best) return { kind: "NONE", matchedShopId: null, reasons: [] };
  // The same owner's other shop is a branch only when it is not the same mobile / GST / PAN business twice at one place.
  const kind = best.ownerId === shop.ownerId && !best.reasons.includes("NAME_NEARBY") && !best.reasons.includes("NAME_SAME_PIN") ? "BRANCH" : "DUPLICATE";
  return { kind, matchedShopId: best.id, reasons: best.reasons };
}

/* ----------------------------------------------------------- attribution */

/** Marks OPEN leads past their window EXPIRED (leads expire on their own; this keeps the rows honest). */
export async function expireLeads(client: DbClient = db): Promise<number> {
  const rows = await client
    .update(dealerLeads)
    .set({ status: "EXPIRED", closedReason: "the attribution window ended", updatedAt: new Date() })
    .where(and(eq(dealerLeads.status, "OPEN"), lt(dealerLeads.expiresAt, new Date())))
    .returning({ id: dealerLeads.id });
  return rows.length;
}

async function employeeFor(dealerId: string, text: string | null, client: DbClient): Promise<string | null> {
  const t = (text ?? "").trim();
  if (!t) return null;
  const people = await client
    .select({ id: dealerSalespeople.id, employeeId: dealerSalespeople.employeeId, name: dealerSalespeople.name })
    .from(dealerSalespeople)
    .where(and(eq(dealerSalespeople.dealerId, dealerId), eq(dealerSalespeople.status, "ACTIVE")));
  const byId = people.find((p) => p.employeeId.toLowerCase() === t.toLowerCase());
  if (byId) return byId.id;
  const byName = people.filter((p) => p.name.trim().toLowerCase() === t.toLowerCase());
  return byName.length === 1 ? byName[0].id : null;
}

export interface AttributionOptions {
  /** The optional Employee ID / name typed at registration. */
  employeeText?: string | null;
  /** A dealer-assisted registration: the dealer and the employee picked. */
  assisted?: { dealerId: string; salespersonId: string | null } | null;
}

/**
 * Records which dealer brought `shopId` (see the header). Returns the
 * attribution, or null when the programme is off for the shop's district or no
 * dealer is involved. Safe to call twice: an existing attribution is returned
 * unchanged.
 */
export async function recordShopAttribution(shopId: string, actor: Actor, options: AttributionOptions = {}): Promise<ShopAttribution | null> {
  // Programme off: one read of the flag and nothing else.
  const flag = await getFeatureFlag("dealer_programme_enabled");
  if (!flag.enabled) return null;
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop) return null;
  if (!flagCoversDistrict(flag, await districtCodeForPincode(shop.pincode))) return null;
  const [existing] = await db.select().from(shopAttributions).where(eq(shopAttributions.shopId, shopId));
  if (existing) return existing;

  await expireLeads();
  const duplicate = await findLikelyDuplicate(shopId);
  const phone = normalizeIndianMobile(shop.phone);
  const employeeText = (options.employeeText ?? "").trim().slice(0, 120) || null;

  const result = await db.transaction(async (tx) => {
    let dealerId: string | null = null;
    let salespersonId: string | null = null;
    let leadId: string | null = null;
    let source: AttributionSource | null = null;

    // 1. A code at registration (or the dealer's own, attached by a dealer-assisted registration).
    if (shop.referralCodeId) {
      const [link] = await tx.select().from(dealerCodes).where(eq(dealerCodes.referralCodeId, shop.referralCodeId));
      dealerId = link?.dealerId ?? (await directDealer(tx)).id;
      salespersonId = link?.salespersonId ?? null;
      source = options.assisted ? "DEALER_ASSISTED" : "CODE_AT_REGISTRATION";
    } else if (options.assisted) {
      dealerId = options.assisted.dealerId;
      source = "DEALER_ASSISTED";
    }
    if (options.assisted?.salespersonId && dealerId === options.assisted.dealerId) salespersonId = salespersonId ?? options.assisted.salespersonId;
    if (dealerId && !salespersonId) salespersonId = await employeeFor(dealerId, employeeText, tx);

    // 2. No code: the earliest open, consented lead for this mobile or GSTIN, of an approved dealer.
    const matching = phone || shop.gstin
      ? await tx
          .select({ lead: dealerLeads, dealerStatus: dealers.status })
          .from(dealerLeads)
          .innerJoin(dealers, eq(dealers.id, dealerLeads.dealerId))
          .where(
            and(
              eq(dealerLeads.status, "OPEN"),
              or(phone ? eq(dealerLeads.phoneE164, phone) : sql`false`, shop.gstin ? eq(dealerLeads.gstin, shop.gstin) : sql`false`),
            ),
          )
          .orderBy(asc(dealerLeads.createdAt))
          .for("update", { of: dealerLeads })
      : [];
    if (!dealerId) {
      const winner = matching.find((m) => m.dealerStatus === "APPROVED");
      if (winner) {
        dealerId = winner.lead.dealerId;
        salespersonId = winner.lead.salespersonId;
        leadId = winner.lead.id;
        source = "LEAD";
      }
    }
    if (!dealerId || !source) return null;

    // 3. The lead that won converts; every other open lead for this shop closes, with the reason.
    const closed: { dealerId: string; shopName: string }[] = [];
    for (const m of matching) {
      if (m.lead.id === leadId) {
        await tx.update(dealerLeads).set({ status: "CONVERTED", convertedShopId: shopId, updatedAt: new Date() }).where(eq(dealerLeads.id, m.lead.id));
        continue;
      }
      if (m.lead.dealerId === dealerId) {
        await tx.update(dealerLeads).set({ status: "CONVERTED", convertedShopId: shopId, updatedAt: new Date() }).where(eq(dealerLeads.id, m.lead.id));
        if (!leadId) leadId = m.lead.id;
        continue;
      }
      const reason =
        source === "LEAD" ? "another dealer documented this shop earlier" : source === "DEALER_ASSISTED" ? "another dealer registered the shop" : "the shop registered with another dealer's code";
      await tx.update(dealerLeads).set({ status: "CLOSED", closedReason: reason, convertedShopId: shopId, updatedAt: new Date() }).where(eq(dealerLeads.id, m.lead.id));
      closed.push({ dealerId: m.lead.dealerId, shopName: m.lead.shopName });
    }

    // One unique key (the primary key, shop_id): a target-less DO NOTHING is safe on the split layout.
    const inserted = await tx
      .insert(shopAttributions)
      .values({
        shopId,
        dealerId,
        salespersonId,
        referralCodeId: shop.referralCodeId,
        leadId,
        source,
        employeeText,
        matchKind: duplicate.kind,
        matchedShopId: duplicate.matchedShopId,
        matchReasons: duplicate.reasons,
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0] ?? (await tx.select().from(shopAttributions).where(eq(shopAttributions.shopId, shopId)))[0];
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_ATTRIBUTION_RECORDED,
        entityType: "shop",
        entityId: shopId,
        newValue: { dealerId, salespersonId, leadId, source, matchKind: duplicate.kind, matchReasons: duplicate.reasons, closedLeads: closed.length },
      },
      tx,
    );

    // Tell the dealers (queued; delivered after the commit).
    const dealerRows = await tx
      .select({ id: dealers.id, userId: dealers.userId, isInternal: dealers.isInternal })
      .from(dealers)
      .where(inArray(dealers.id, [dealerId, ...closed.map((c) => c.dealerId)]));
    const userOf = new Map(dealerRows.map((d) => [d.id, d]));
    const winner = userOf.get(dealerId);
    if (winner?.userId && !winner.isInternal && inserted[0]) {
      const [person] = salespersonId ? await tx.select({ name: dealerSalespeople.name }).from(dealerSalespeople).where(eq(dealerSalespeople.id, salespersonId)) : [];
      await notify(
        {
          userId: winner.userId,
          type: NOTIFICATION_TYPES.DEALER_SHOP_ATTRIBUTED,
          vars: { shopName: shop.name, area: shop.area ?? shop.city, employee: person ? ` (by ${person.name})` : "" },
          actionUrl: "/dealer",
          dedupeKey: `dealer-shop:${shopId}`,
        },
        tx,
      );
    }
    for (const c of closed) {
      const d = userOf.get(c.dealerId);
      if (d?.userId) {
        await notify(
          {
            userId: d.userId,
            type: NOTIFICATION_TYPES.DEALER_LEAD_CLOSED,
            vars: { shopName: c.shopName, reason: "the shop registered with another dealer" },
            actionUrl: "/dealer",
            dedupeKey: `dealer-lead-closed:${shopId}:${c.dealerId}`,
          },
          tx,
        );
      }
    }
    return row;
  });
  return result;
}

/** Never lets a dealer-attribution problem break a registration: logs and returns null. */
export async function recordShopAttributionSafely(shopId: string, actor: Actor, options: AttributionOptions = {}): Promise<ShopAttribution | null> {
  try {
    const attribution = await recordShopAttribution(shopId, actor, options);
    // A shop attributed after its fee was paid (or approval) has already reached milestones.
    if (attribution) await checkCommissionMilestonesSafely(shopId, actor);
    return attribution;
  } catch (error) {
    console.error("[dealers] could not record the shop's dealer attribution", shopId, error instanceof Error ? error.message : error);
    return null;
  }
}
