/**
 * SM-004 per-delivery status of a subscription — client-safe.
 *
 * Every delivery date of a subscription carries its own status
 * (subscription_deliveries, migration 0052):
 *
 *   SCHEDULED  the schedule says a delivery will happen; no order yet
 *   SKIPPED    the customer skipped the date, or it falls in a pause
 *   …then, once the day's order exists, exactly the order's own status
 *   (CONFIRMED, ACCEPTED, PREPARING, READY, ASSIGNED, PICKED_UP,
 *   OUT_FOR_DELIVERY, DELIVERED, FAILED, CANCELLED, WALLET_INSUFFICIENT …),
 *   kept in step with the order by a database trigger.
 *
 * So the names are the order statuses plus two that only a schedule has.
 */

/** Same values, same order as order_status (schema.ts orderStatusEnum). */
export const ORDER_STATUS_VALUES = [
  "PENDING",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "PAYMENT_FAILED",
  "WALLET_INSUFFICIENT",
  "REFUND_PENDING",
  "REFUNDED",
  "ACCEPTED",
  "ASSIGNED",
  "PICKED_UP",
  "FAILED",
  "RETURNED",
  "DISPUTED",
] as const;

export const SCHEDULE_ONLY_STATUSES = ["SCHEDULED", "SKIPPED"] as const;

export const SUBSCRIPTION_DELIVERY_STATUSES = [...SCHEDULE_ONLY_STATUSES, ...ORDER_STATUS_VALUES] as const;
export type SubscriptionDeliveryStatus = (typeof SUBSCRIPTION_DELIVERY_STATUSES)[number];

/** Why a date is SKIPPED (or FAILED without an order). */
export const DELIVERY_SKIP_REASONS = ["SKIPPED_BY_CUSTOMER", "PAUSED", "UNAVAILABLE"] as const;
export type DeliverySkipReason = (typeof DELIVERY_SKIP_REASONS)[number];

export const DELIVERY_STATUS_LABELS: Record<SubscriptionDeliveryStatus, string> = {
  SCHEDULED: "Scheduled",
  SKIPPED: "Skipped",
  PENDING: "Being placed",
  CONFIRMED: "Confirmed",
  ACCEPTED: "Accepted by shop",
  PREPARING: "Preparing",
  READY: "Ready for pickup",
  ASSIGNED: "Rider assigned",
  PICKED_UP: "Out for delivery",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
  RETURNED: "Returned",
  CANCELLED: "Cancelled",
  PAYMENT_FAILED: "Payment failed",
  WALLET_INSUFFICIENT: "Payment failed — wallet too low",
  REFUND_PENDING: "Refund pending",
  REFUNDED: "Refunded",
  DISPUTED: "Disputed",
};

export const DELIVERY_SKIP_REASON_LABELS: Record<DeliverySkipReason, string> = {
  SKIPPED_BY_CUSTOMER: "skipped by you",
  PAUSED: "subscription paused",
  UNAVAILABLE: "product unavailable that day",
};

export type DeliveryTone = "neutral" | "info" | "success" | "warning" | "danger";

export function deliveryStatusTone(status: SubscriptionDeliveryStatus): DeliveryTone {
  switch (status) {
    case "DELIVERED":
      return "success";
    case "SCHEDULED":
    case "PENDING":
    case "CONFIRMED":
    case "ACCEPTED":
    case "PREPARING":
    case "READY":
    case "ASSIGNED":
    case "PICKED_UP":
    case "OUT_FOR_DELIVERY":
      return "info";
    case "SKIPPED":
      return "neutral";
    case "FAILED":
    case "CANCELLED":
    case "PAYMENT_FAILED":
    case "WALLET_INSUFFICIENT":
    case "RETURNED":
    case "DISPUTED":
      return "danger";
    case "REFUND_PENDING":
    case "REFUNDED":
      return "warning";
  }
}

const isScheduleOnly = (s: string) => (SCHEDULE_ONLY_STATUSES as readonly string[]).includes(s);

/**
 * Allowed moves, enforced by the database trigger on subscription_deliveries
 * (SQL: subscription_delivery_transition_ok):
 *   SCHEDULED ⇄ SKIPPED (skip / un-skip, pause / resume)
 *   SCHEDULED or SKIPPED → any order status (the day's order now exists — the
 *     order is the truth — or FAILED/CANCELLED with no order: unavailable that
 *     day, subscription ended)
 *   order status → any order status (the order's own state machine rules them)
 * Never back from an order status to SCHEDULED or SKIPPED.
 */
export function isAllowedDeliveryTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (isScheduleOnly(from)) return true;
  return !isScheduleOnly(to);
}
