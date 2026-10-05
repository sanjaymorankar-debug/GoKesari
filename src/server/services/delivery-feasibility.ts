/**
 * Delivery-window feasibility (delivery-system Part 58 follow-up, Slice C).
 *
 * "Do not promise a delivery window unless the system determines that the
 * order can reasonably be fulfilled within that window" (§6, §21). This is
 * a Phase 1 approximation on purpose: straight-line Haversine distance to
 * the nearest online, approved, in-range delivery partner, converted to a
 * travel-time estimate with a flat assumed speed — not a real Google
 * Routes/Distance Matrix call. That's explicitly deferred to Phase 2, once
 * multi-order batching needs actual route sequencing to justify the cost
 * (see MAPS_USAGE.md).
 */
import { eq } from "drizzle-orm";

import { parseCoordinates } from "@/lib/geo/haversine";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { findEligiblePartnersNearShop } from "./delivery-eligibility";
import { getSlotAvailability } from "./delivery-slots";
import { getRoute } from "./routing";

/** Phase 1 placeholder for real travel-time estimation — see file header. */
const ASSUMED_AVERAGE_SPEED_KMH = 20;

export interface DeliveryWindowFeasibility {
  EXPRESS_30: boolean;
  STANDARD_60: boolean;
  /** Scheduled delivery doesn't depend on a rider being online right now. */
  SCHEDULED: boolean;
  nearestPartnerDistanceKm: number | null;
  estimatedMinutes: number | null;
  /**
   * F5: windows whose current delivery slot is full (only present when slot
   * capacity is on). A full window is also reported as not feasible above.
   */
  full?: Partial<Record<"EXPRESS_30" | "STANDARD_60" | "SCHEDULED", boolean>>;
}

const INFEASIBLE_NO_SCHEDULE: DeliveryWindowFeasibility = {
  EXPRESS_30: false,
  STANDARD_60: false,
  SCHEDULED: false,
  nearestPartnerDistanceKm: null,
  estimatedMinutes: null,
};

export async function getFeasibleDeliveryWindows(shopId: string): Promise<DeliveryWindowFeasibility> {
  const feasibility = await liveFeasibility(shopId);
  // F5: a window whose current slot is full is not offered. With slot
  // capacity off this returns the live result unchanged.
  if (!feasibility.EXPRESS_30 && !feasibility.STANDARD_60 && !feasibility.SCHEDULED) return feasibility;
  const availability = await getSlotAvailability(shopId);
  if (!availability.enabled) return feasibility;
  const full = {
    EXPRESS_30: availability.slots.EXPRESS_30.full,
    STANDARD_60: availability.slots.STANDARD_60.full,
    SCHEDULED: availability.slots.SCHEDULED.full,
  };
  return {
    ...feasibility,
    EXPRESS_30: feasibility.EXPRESS_30 && !full.EXPRESS_30,
    STANDARD_60: feasibility.STANDARD_60 && !full.STANDARD_60,
    SCHEDULED: feasibility.SCHEDULED && !full.SCHEDULED,
    full,
  };
}

async function liveFeasibility(shopId: string): Promise<DeliveryWindowFeasibility> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop || !shop.deliveryAvailable) return INFEASIBLE_NO_SCHEDULE;

  const shopCoords = parseCoordinates(shop.latitude, shop.longitude);
  // No verified shop location on file yet — cannot judge live feasibility,
  // but scheduled delivery (coordinated directly, not distance-gated) is
  // still offerable.
  if (!shopCoords) {
    return { ...INFEASIBLE_NO_SCHEDULE, SCHEDULED: true };
  }

  // DEF-05 fix (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): this preview
  // and actual dispatch (assignNearestPartner) now share ONE eligibility
  // predicate — same busy rule (OFFERED/ACCEPTED/PICKED_UP, not just
  // ACCEPTED), same soft-delete check — so a partner shown as "available"
  // here can no longer turn out ineligible moments later at assignment time.
  const available = await findEligiblePartnersNearShop(shopCoords);

  if (available.length === 0) {
    return { ...INFEASIBLE_NO_SCHEDULE, SCHEDULED: true };
  }

  const nearestKm = available[0].distanceToShopKm;
  // F4: road travel time from the nearest rider when routing is on;
  // straight-line at the assumed speed otherwise (identical to before).
  const riderCoords = parseCoordinates(available[0].partner.lastLocationLatitude, available[0].partner.lastLocationLongitude);
  const travelMinutes = riderCoords
    ? (await getRoute(riderCoords, shopCoords, { purpose: "delivery_window_estimate", entityType: "shop", entityId: shop.id }))
        .durationSeconds / 60
    : (nearestKm / ASSUMED_AVERAGE_SPEED_KMH) * 60;
  const totalMinutes = shop.preparationTimeMinutes + travelMinutes;

  return {
    EXPRESS_30: totalMinutes <= 30,
    STANDARD_60: totalMinutes <= 60,
    SCHEDULED: true,
    nearestPartnerDistanceKm: nearestKm,
    estimatedMinutes: Math.ceil(totalMinutes),
  };
}

export const DELIVERY_WINDOW_MINUTES: Record<"EXPRESS_30" | "STANDARD_60", number> = {
  EXPRESS_30: 30,
  STANDARD_60: 60,
};
