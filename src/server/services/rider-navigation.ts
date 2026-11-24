/**
 * In-app turn-by-turn navigation for the rider (F4.2.2, GAP-002 —
 * batch-2026-10 WS-B). Rule `riderNavigation` (off by default: riders keep
 * the "Navigate" links that open Google Maps).
 *
 * Only the rider holding the delivery gets a route (403 for anyone else).
 * Leg 1 (accepted, not yet picked up): rider → shop. Leg 2 (picked up): rider
 * → customer. The customer's exact location is used only from pickup — before
 * that the rider sees their area only (same privacy rule as the dashboard).
 *
 * Module 4 (rule riderNavigation.multiStop, off by default): when the rider
 * carries a batched trip (rule batching), the view also lists the trip's
 * stops in order (delivery-trips.ts getRiderTrip) and names the next one.
 * None of the routing providers is sent waypoints: the route always goes to
 * the next stop, and "Next stop" opens that stop's route once this one is
 * done. Without a trip (or with the rule off) nothing changes.
 */
import { eq } from "drizzle-orm";

import { conflict, forbidden, notFound } from "@/lib/errors";
import { parseCoordinates } from "@/lib/geo/haversine";
import type { LatLng, NavRoute } from "@/lib/navigation/geometry";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, orders, shops } from "@/server/db/schema";
import { getNavigationRoute } from "@/server/routing";
import { getRiderTrip } from "./delivery-trips";
import { getRule } from "./settings";

export interface DeliveryNavigation {
  deliveryOrderId: string;
  orderNumber: string;
  status: "ACCEPTED" | "PICKED_UP";
  leg: "TO_SHOP" | "TO_CUSTOMER";
  origin: LatLng;
  destination: LatLng & { label: string };
  route: NavRoute;
  /** "Open in Google Maps" fallback (the same deep link the dashboard uses). */
  googleMapsUrl: string;
  settings: {
    offRouteMeters: number;
    rerouteCooldownSeconds: number;
    voiceDefaultOn: boolean;
    /** Rule tracking.riderPingSeconds — the live-tracking cadence once the drop has started. */
    trackingPingSeconds: number;
  };
  /** The drop has started: location goes to the delivery's live-tracking endpoint. */
  dropStarted: boolean;
  /** Module 4: the batched trip's stops (rule riderNavigation.multiStop); absent on a single delivery. */
  trip?: NavigationTrip | null;
}

export interface NavigationTripStop {
  kind: "PICKUP" | "DROP";
  deliveryOrderId: string;
  orderNumber: string;
  label: string;
  done: boolean;
  current: boolean;
  eta: string | null;
  late: boolean;
}

export interface NavigationTrip {
  stops: NavigationTripStop[];
  /** The first stop not yet done — where "Next stop" leads; null when every stop is done. */
  nextStop: NavigationTripStop | null;
}

/**
 * Module 4: the rider's batched trip for the navigation screen, or null — rule
 * riderNavigation.multiStop off, rule batching off, or the rider carries one
 * order. Never throws (navigation keeps working without the list).
 */
export async function getNavigationTrip(userId: string): Promise<NavigationTrip | null> {
  try {
    const [nav, batching] = await Promise.all([getRule("riderNavigation"), getRule("batching")]);
    if (!nav.multiStop || !batching.enabled) return null;
    const trip = await getRiderTrip(userId);
    if (!trip) return null;
    const stops: NavigationTripStop[] = trip.stops.map((s) => ({
      kind: s.kind,
      deliveryOrderId: s.deliveryOrderId,
      orderNumber: s.orderNumber,
      label: s.label,
      done: s.done,
      current: s.current,
      eta: s.eta,
      late: s.late,
    }));
    return { stops, nextStop: stops.find((s) => s.current) ?? null };
  } catch (error) {
    console.error("[rider-navigation] trip lookup failed", error);
    return null;
  }
}

/** Same deep link as delivery-assignment.ts navigationUrl(). */
export function googleMapsDirectionsUrl(to: LatLng): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${to.latitude},${to.longitude}`;
}

export async function isRiderNavigationEnabled(): Promise<boolean> {
  return (await getRule("riderNavigation")).enabled;
}

/** Ownership-checked load of the rider's delivery (403 for another rider). */
async function loadForRider(deliveryOrderId: string, userId: string) {
  const [row] = await db
    .select({ delivery: deliveryOrders, partnerUserId: deliveryPartners.userId, partner: deliveryPartners })
    .from(deliveryOrders)
    .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryOrders.deliveryPartnerId))
    .where(eq(deliveryOrders.id, deliveryOrderId));
  if (!row) throw notFound("Delivery assignment");
  if (row.partnerUserId !== userId) throw forbidden("This delivery assignment does not belong to you.");
  return row;
}

export async function getDeliveryNavigation(
  deliveryOrderId: string,
  userId: string,
  position?: LatLng | null,
): Promise<DeliveryNavigation> {
  const rule = await getRule("riderNavigation");
  if (!rule.enabled) throw notFound("In-app navigation");
  const { delivery, partner } = await loadForRider(deliveryOrderId, userId);
  if (delivery.status !== "ACCEPTED" && delivery.status !== "PICKED_UP") {
    throw conflict("Navigation is available once you have accepted the delivery, until it is delivered.");
  }

  const [row] = await db
    .select({
      orderNumber: orders.orderNumber,
      snapshot: orders.deliveryAddressSnapshot,
      shopName: shops.name,
      shopLatitude: shops.latitude,
      shopLongitude: shops.longitude,
      pickupLatitude: shops.pickupLatitude,
      pickupLongitude: shops.pickupLongitude,
    })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, delivery.orderId));
  if (!row) throw notFound("Order");

  const toShop = delivery.status === "ACCEPTED";
  const shopCoords =
    parseCoordinates(row.pickupLatitude, row.pickupLongitude) ?? parseCoordinates(row.shopLatitude, row.shopLongitude);
  const customerCoords = parseCoordinates(row.snapshot?.latitude ?? null, row.snapshot?.longitude ?? null);
  const destination = toShop ? shopCoords : customerCoords;
  if (!destination) {
    throw conflict(
      toShop
        ? "The shop has no location on file — use the address on the order."
        : "The customer's address has no map location — use the address on the order.",
    );
  }
  const origin =
    position ?? parseCoordinates(partner.lastLocationLatitude, partner.lastLocationLongitude) ?? (toShop ? destination : shopCoords ?? destination);

  const route = await getNavigationRoute(origin, destination, { entityType: "delivery_order", entityId: delivery.id });
  const tracking = await getRule("tracking");
  const label = toShop
    ? row.shopName
    : [row.snapshot?.line1, row.snapshot?.line2, row.snapshot?.area, row.snapshot?.city].filter(Boolean).join(", ") || "Customer";

  return {
    deliveryOrderId: delivery.id,
    orderNumber: row.orderNumber,
    status: delivery.status,
    leg: toShop ? "TO_SHOP" : "TO_CUSTOMER",
    origin,
    destination: { ...destination, label },
    route,
    googleMapsUrl: googleMapsDirectionsUrl(destination),
    settings: {
      offRouteMeters: rule.offRouteMeters,
      rerouteCooldownSeconds: rule.rerouteCooldownSeconds,
      voiceDefaultOn: rule.voiceDefaultOn,
      trackingPingSeconds: tracking.riderPingSeconds,
    },
    dropStarted: delivery.status === "PICKED_UP" && delivery.outForDeliveryAt != null,
    trip: await getNavigationTrip(userId),
  };
}
