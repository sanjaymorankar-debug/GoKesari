/**
 * Shared delivery-partner eligibility predicate (DEF-05 —
 * docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md).
 *
 * Deliberately its own, dependency-free module rather than living inside
 * delivery-assignment.ts or delivery-feasibility.ts: those two already
 * depend on each other transitively (delivery-assignment.ts -> orders.ts ->
 * delivery-feasibility.ts), so either one importing the OTHER directly would
 * create a circular import. This module depends on neither, and both of them
 * import from here instead — the one place "who counts as available" is
 * decided, so the checkout-time feasibility preview and actual dispatch can
 * no longer disagree about it.
 */
import { and, count, eq, inArray, isNull } from "drizzle-orm";

import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { db, type DbClient } from "@/server/db";
import { deliveryOrders, deliveryPartners, societyPartnerAccess, type DeliveryPartner } from "@/server/db/schema";
import type { RuleValue } from "@/server/config/rules";
import { getRule } from "./settings";
import { bookedPartnerIdsNow } from "./rider-slot-bookings";
import { priorityPartnerIds } from "./rider-tiers";

type Coords = { latitude: number; longitude: number };
type ZoningRule = RuleValue<"riderZoning">;

export interface ZoneCheck {
  ok: boolean;
  /** Why not, for the rider or the log: null when ok. */
  reason: "NO_LIVE_LOCATION" | "STALE_LOCATION" | "PICKUP_TOO_FAR" | "DROP_TOO_FAR" | null;
  distanceToShopKm: number | null;
  distanceToDropKm: number | null;
}

/**
 * Gig worker flow (feature 6): is this rider's LIVE location (never the
 * registration address) inside the zone for an order? Pickup within the
 * platform radius and the rider's own operating radius; drop within the
 * platform radius (skipped when the address has no coordinates). With the
 * rule off: the shop-only check of before (the rider's own radius, any age).
 */
export function checkZone(
  partner: Pick<DeliveryPartner, "lastLocationLatitude" | "lastLocationLongitude" | "lastLocationAt" | "operatingRadiusKm">,
  shopCoords: Coords,
  dropCoords: Coords | null,
  rule: ZoningRule,
  now: Date = new Date(),
): ZoneCheck {
  const at = parseCoordinates(partner.lastLocationLatitude, partner.lastLocationLongitude);
  if (!at) return { ok: false, reason: "NO_LIVE_LOCATION", distanceToShopKm: null, distanceToDropKm: null };
  const distanceToShopKm = haversineDistanceKm(shopCoords, at);
  const distanceToDropKm = dropCoords ? haversineDistanceKm(dropCoords, at) : null;
  const result = (reason: ZoneCheck["reason"]): ZoneCheck => ({ ok: reason === null, reason, distanceToShopKm, distanceToDropKm });
  if (!rule.enabled) return result(distanceToShopKm > partner.operatingRadiusKm ? "PICKUP_TOO_FAR" : null);

  const ageMs = partner.lastLocationAt ? now.getTime() - partner.lastLocationAt.getTime() : Infinity;
  if (ageMs > rule.maxLocationAgeMinutes * 60_000) return result("STALE_LOCATION");
  if (distanceToShopKm > Math.min(rule.radiusKm, partner.operatingRadiusKm)) return result("PICKUP_TOO_FAR");
  if (distanceToDropKm != null && distanceToDropKm > rule.radiusKm) return result("DROP_TOO_FAR");
  return result(null);
}

export async function getZoningRule(): Promise<ZoningRule> {
  return getRule("riderZoning");
}

/** Partners GoKesari's admin blocked for this society (features 7 and 8): never offered its orders. */
export async function blockedPartnerIds(societyId: string | null | undefined, client: DbClient = db): Promise<Set<string>> {
  if (!societyId) return new Set();
  const rows = await client
    .select({ id: societyPartnerAccess.deliveryPartnerId })
    .from(societyPartnerAccess)
    .where(and(eq(societyPartnerAccess.societyId, societyId), eq(societyPartnerAccess.access, "BLOCKED")));
  return new Set(rows.map((r) => r.id));
}

/** A partner holding any of these on ANY order counts as "busy" — cannot take a new assignment. */
export const ACTIVE_ASSIGNMENT_STATUSES = ["OFFERED", "ACCEPTED", "PICKED_UP"] as const;

/** How many deliveries a rider currently holds (offered, accepted or picked up). */
export async function countActiveAssignments(partnerId: string, client: DbClient = db): Promise<number> {
  const [row] = await client
    .select({ n: count() })
    .from(deliveryOrders)
    .where(and(eq(deliveryOrders.deliveryPartnerId, partnerId), inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES)));
  return row?.n ?? 0;
}

/**
 * Approved, Ready (gig worker flow: Active riders get no new orders), not
 * soft-deleted, inside the zone (`checkZone`), not blocked for the order's
 * society, and not already busy — sorted nearest-first. `client` lets a caller already inside a transaction
 * (assignNearestPartner) see its own uncommitted locks; omit it for a plain
 * outside-transaction read (the feasibility preview).
 *
 * F3: with `includeBusyUpTo` set, riders holding fewer than that many
 * deliveries are kept too (activeCount > 0) — callers rank them after free
 * riders. Without it (every caller's default) busy riders are excluded as
 * before.
 */
/**
 * Rider App v2 dispatch group: 0 = booked the running slot (riderSlotBooking), 1 = tier with
 * priority (riderTiers), 2 = everyone else. Lower goes first; distance and the other nudges order
 * riders only within a group.
 */
export type DispatchPriority = 0 | 1 | 2;

export async function findEligiblePartnersNearShop(
  shopCoords: { latitude: number; longitude: number },
  client: DbClient = db,
  options: {
    includeBusyUpTo?: number;
    /** Gig worker flow: the delivery address; the rider must be within the zone of it too. */
    dropCoords?: { latitude: number; longitude: number } | null;
    /** Gig worker flow: the order's society; partners blocked there are left out. */
    societyId?: string | null;
  } = {},
): Promise<{ partner: DeliveryPartner; distanceToShopKm: number; activeCount: number; priority: DispatchPriority }[]> {
  const candidates = await client.query.deliveryPartners.findMany({
    where: and(
      eq(deliveryPartners.status, "APPROVED"),
      eq(deliveryPartners.isOnline, true),
      eq(deliveryPartners.availability, "READY"),
      isNull(deliveryPartners.deletedAt),
    ),
  });
  const rule = await getZoningRule();
  const blocked = await blockedPartnerIds(options.societyId, client);
  const now = new Date();

  const inRange = candidates
    .map((partner) => {
      if (blocked.has(partner.id)) return null;
      const zone = checkZone(partner, shopCoords, options.dropCoords ?? null, rule, now);
      if (!zone.ok || zone.distanceToShopKm == null) return null;
      return { partner, distanceToShopKm: zone.distanceToShopKm };
    })
    .filter((v): v is { partner: DeliveryPartner; distanceToShopKm: number } => v !== null)
    .sort((a, b) => a.distanceToShopKm - b.distanceToShopKm);

  // Rider App v2: riders who booked the running slot (rule riderSlotBooking) or whose tier has
  // priority (rule riderTiers) are offered first, nearest first within each group. Both sets are
  // empty while their rules are off, so the order is the plain distance order as before.
  // Each candidate carries its group (`priority`) so the later ranking (rankCandidates) keeps it.
  let rank: (id: string) => DispatchPriority = () => 2;
  if (inRange.length > 1) {
    const ids = inRange.map((c) => c.partner.id);
    const [booked, tiered] = await Promise.all([
      bookedPartnerIdsNow(now).catch(() => new Set<string>()),
      priorityPartnerIds(ids, now).catch(() => new Set<string>()),
    ]);
    if (booked.size > 0 || tiered.size > 0) {
      rank = (id: string) => (booked.has(id) ? 0 : tiered.has(id) ? 1 : 2);
      inRange.sort((a, b) => rank(a.partner.id) - rank(b.partner.id) || a.distanceToShopKm - b.distanceToShopKm);
    }
  }

  const available: { partner: DeliveryPartner; distanceToShopKm: number; activeCount: number; priority: DispatchPriority }[] = [];
  for (const inZone of inRange) {
    const candidate = { ...inZone, priority: rank(inZone.partner.id) };
    if (!options.includeBusyUpTo) {
      const busy = await client.query.deliveryOrders.findFirst({
        where: and(
          eq(deliveryOrders.deliveryPartnerId, candidate.partner.id),
          inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
        ),
      });
      if (!busy) available.push({ ...candidate, activeCount: 0 });
      continue;
    }
    const activeCount = await countActiveAssignments(candidate.partner.id, client);
    if (activeCount < options.includeBusyUpTo) available.push({ ...candidate, activeCount });
  }
  return available;
}
