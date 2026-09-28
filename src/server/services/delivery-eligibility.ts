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
import { and, eq, inArray, isNull } from "drizzle-orm";

import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { db, type DbClient } from "@/server/db";
import { deliveryOrders, deliveryPartners, type DeliveryPartner } from "@/server/db/schema";

/** A partner holding any of these on ANY order counts as "busy" — cannot take a new assignment. */
export const ACTIVE_ASSIGNMENT_STATUSES = ["OFFERED", "ACCEPTED", "PICKED_UP"] as const;

/**
 * Approved, online, not soft-deleted, in-radius, and not already busy —
 * sorted nearest-first. `client` lets a caller already inside a transaction
 * (assignNearestPartner) see its own uncommitted locks; omit it for a plain
 * outside-transaction read (the feasibility preview).
 */
export async function findEligiblePartnersNearShop(
  shopCoords: { latitude: number; longitude: number },
  client: DbClient = db,
): Promise<{ partner: DeliveryPartner; distanceToShopKm: number }[]> {
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

  const available: typeof inRange = [];
  for (const candidate of inRange) {
    const busy = await client.query.deliveryOrders.findFirst({
      where: and(
        eq(deliveryOrders.deliveryPartnerId, candidate.partner.id),
        inArray(deliveryOrders.status, ACTIVE_ASSIGNMENT_STATUSES),
      ),
    });
    if (!busy) available.push(candidate);
  }
  return available;
}
