import { haversineDistanceKm } from "@/lib/geo/haversine";
import type { DeliveryOrderStatus, OrderStatus } from "@/server/db/schema";

const ASSUMED_AVERAGE_SPEED_KMH = 20;
const LIVE_LOCATION_MAX_AGE_MS = 5 * 60 * 1000;

type OrderPhase = "PRE_PICKUP" | "EN_ROUTE" | "HALTED" | "ENDED";

const ORDER_PHASE: Record<OrderStatus, OrderPhase> = {
  PENDING: "PRE_PICKUP",
  CONFIRMED: "PRE_PICKUP",
  ACCEPTED: "PRE_PICKUP",
  PREPARING: "PRE_PICKUP",
  READY: "PRE_PICKUP",
  ASSIGNED: "PRE_PICKUP",
  PICKED_UP: "EN_ROUTE",
  OUT_FOR_DELIVERY: "EN_ROUTE",
  PAYMENT_FAILED: "HALTED",
  WALLET_INSUFFICIENT: "HALTED",
  FAILED: "HALTED",
  DELIVERED: "ENDED",
  DISPUTED: "ENDED",
  RETURNED: "ENDED",
  CANCELLED: "ENDED",
  REFUND_PENDING: "ENDED",
  REFUNDED: "ENDED",
};

const RIDER_ENGAGED_DELIVERY_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set(["OFFERED", "ACCEPTED"]);
const REDISPATCHABLE_DELIVERY_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set(["REJECTED", "CANCELLED"]);

export type TrackingStage = "AWAITING_PICKUP" | "IN_PROGRESS" | "NOT_TRACKED" | "ENDED";

/**
 * Whether an order is far enough along, and not yet finished, for a tracking
 * panel to be worth mounting (GS-042/NAV-004).
 *
 * Callers use this to decide whether to render the panel at all, so that a
 * page listing many orders only opens a poll for the ones actually in flight.
 * It deliberately answers from the order status alone — the panel itself calls
 * the API, which is the authority on what the viewer may see and resolves the
 * finer stage (awaiting pickup / in progress / not tracked).
 */
export function isTrackableOrderStatus(status: OrderStatus | string): boolean {
  // Callers include UI rows that carry the status as a plain string; an
  // unrecognised value is simply not trackable rather than a crash.
  const phase: OrderPhase | undefined = ORDER_PHASE[status as OrderStatus];
  return phase === "PRE_PICKUP" || phase === "EN_ROUTE";
}

interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface OrderTracking {
  orderId: string;
  orderStatus: OrderStatus;
  deliveryStatus: DeliveryOrderStatus | null;
  stage: TrackingStage;
  riderLocation: (Coordinates & { recordedAt: string }) | null;
  distanceToDestinationKm: number | null;
  etaMinutes: number | null;
  /** F4: how distance/ETA were worked out — by road, or straight-line at the assumed speed. */
  etaSource: "ROAD" | "STRAIGHT_LINE" | null;
  /** F4: expected arrival at the customer (ISO), when it can be estimated. */
  estimatedArrivalAt: string | null;
}

function trackingStage(
  orderStatus: OrderStatus,
  deliveryStatus: DeliveryOrderStatus | null,
  shopDispatchesRiders: boolean,
): TrackingStage {
  switch (ORDER_PHASE[orderStatus]) {
    case "ENDED":
      return "ENDED";
    case "EN_ROUTE":
      return deliveryStatus === "PICKED_UP" ? "IN_PROGRESS" : "NOT_TRACKED";
    case "PRE_PICKUP":
      if (deliveryStatus && RIDER_ENGAGED_DELIVERY_STATUSES.has(deliveryStatus)) return "AWAITING_PICKUP";
      if (shopDispatchesRiders && (deliveryStatus === null || REDISPATCHABLE_DELIVERY_STATUSES.has(deliveryStatus))) {
        return "AWAITING_PICKUP";
      }
      return "NOT_TRACKED";
    case "HALTED":
      return "NOT_TRACKED";
  }
}

export function buildOrderTracking(input: {
  orderId: string;
  orderStatus: OrderStatus;
  shopDispatchesRiders: boolean;
  delivery: { status: DeliveryOrderStatus; pickedUpAt: Date | null } | null;
  riderFix: (Coordinates & { recordedAt: Date }) | null;
  destination: Coordinates | null;
  now: Date;
  /** F4: road route from the rider's fix to the destination, when routing is on. */
  route?: { distanceKm: number; durationSeconds: number; source: "ROAD" | "STRAIGHT_LINE" } | null;
  /**
   * F4: before pickup — expected seconds from offer to arrival
   * (rider → shop + shop → customer) and when the offer was made.
   */
  plannedTrip?: { offeredAt: Date; totalSeconds: number; source: "ROAD" | "STRAIGHT_LINE" } | null;
}): OrderTracking {
  const { delivery, riderFix, destination, now } = input;
  const deliveryStatus = delivery?.status ?? null;
  const stage = trackingStage(input.orderStatus, deliveryStatus, input.shopDispatchesRiders);

  const pickedUpAt = stage === "IN_PROGRESS" ? (delivery?.pickedUpAt ?? null) : null;
  const fix = pickedUpAt && riderFix && riderFix.recordedAt >= pickedUpAt ? riderFix : null;

  let distanceToDestinationKm: number | null = null;
  let etaMinutes: number | null = null;
  let etaSource: OrderTracking["etaSource"] = null;
  let estimatedArrivalAt: string | null = null;
  if (fix && destination && now.getTime() - fix.recordedAt.getTime() <= LIVE_LOCATION_MAX_AGE_MS) {
    if (input.route) {
      distanceToDestinationKm = Math.round(input.route.distanceKm * 10) / 10;
      etaMinutes = Math.max(1, Math.ceil(input.route.durationSeconds / 60));
      etaSource = input.route.source;
    } else {
      const km = haversineDistanceKm(fix, destination);
      distanceToDestinationKm = Math.round(km * 10) / 10;
      etaMinutes = Math.max(1, Math.ceil((km / ASSUMED_AVERAGE_SPEED_KMH) * 60));
      etaSource = "STRAIGHT_LINE";
    }
    estimatedArrivalAt = new Date(now.getTime() + etaMinutes * 60_000).toISOString();
  } else if (stage === "AWAITING_PICKUP" && input.plannedTrip) {
    const at = input.plannedTrip.offeredAt.getTime() + input.plannedTrip.totalSeconds * 1000;
    // Never promise a time already past: then the best estimate is "shortly".
    estimatedArrivalAt = new Date(Math.max(at, now.getTime() + 60_000)).toISOString();
    etaSource = input.plannedTrip.source;
  }

  return {
    orderId: input.orderId,
    orderStatus: input.orderStatus,
    deliveryStatus,
    stage,
    riderLocation: fix
      ? { latitude: fix.latitude, longitude: fix.longitude, recordedAt: fix.recordedAt.toISOString() }
      : null,
    distanceToDestinationKm,
    etaMinutes,
    etaSource,
    estimatedArrivalAt,
  };
}
