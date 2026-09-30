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
}): OrderTracking {
  const { delivery, riderFix, destination, now } = input;
  const deliveryStatus = delivery?.status ?? null;
  const stage = trackingStage(input.orderStatus, deliveryStatus, input.shopDispatchesRiders);

  const pickedUpAt = stage === "IN_PROGRESS" ? (delivery?.pickedUpAt ?? null) : null;
  const fix = pickedUpAt && riderFix && riderFix.recordedAt >= pickedUpAt ? riderFix : null;

  let distanceToDestinationKm: number | null = null;
  let etaMinutes: number | null = null;
  if (fix && destination && now.getTime() - fix.recordedAt.getTime() <= LIVE_LOCATION_MAX_AGE_MS) {
    const km = haversineDistanceKm(fix, destination);
    distanceToDestinationKm = Math.round(km * 10) / 10;
    etaMinutes = Math.max(1, Math.ceil((km / ASSUMED_AVERAGE_SPEED_KMH) * 60));
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
  };
}
