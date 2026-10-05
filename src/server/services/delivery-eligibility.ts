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
import { deliveryOrders, deliveryPartners, type DeliveryPartner } from "@/server/db/schema";

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
 * Approved, online, not soft-deleted, in-radius, and not already busy —
 * sorted nearest-first. `client` lets a caller already inside a transaction
 * (assignNearestPartner) see its own uncommitted locks; omit it for a plain
 * outside-transaction read (the feasibility preview).
 *
 * F3: with `includeBusyUpTo` set, riders holding fewer than that many
 * deliveries are kept too (activeCount > 0) — callers rank them after free
 * riders. Without it (every caller's default) busy riders are excluded as
 * before.
 */
export async function findEligiblePartnersNearShop(
  shopCoords: { latitude: number; longitude: number },
  client: DbClient = db,
  options: { includeBusyUpTo?: number } = {},
): Promise<{ partner: DeliveryPartner; distanceToShopKm: number; activeCount: number }[]> {
  const candidates = await client.query.deliveryPartners.findMany({
    where: and(
      eq(deliveryPartners.status, "APPROVED"),
      eq(deliveryPartners.isOnline, true),
      isNull(deliveryPartners.deletedAt),
    ),
  });

  const inRange = candidates
    .map((partner) => {
      const coords = parseCoordinates(partner.lastLocationLatitude, partner.lastLocationLongitude);
      if (!coords) return null;
      const distanceToShopKm = haversineDistanceKm(shopCoords, coords);
      if (distanceToShopKm > partner.operatingRadiusKm) return null;
      return { partner, distanceToShopKm };
    })
    .filter((v): v is { partner: DeliveryPartner; distanceToShopKm: number } => v !== null)
    .sort((a, b) => a.distanceToShopKm - b.distanceToShopKm);

  const available: { partner: DeliveryPartner; distanceToShopKm: number; activeCount: number }[] = [];
  for (const candidate of inRange) {
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
