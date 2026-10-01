/**
 * Return workflow vocabulary — shared by the server (state machine) and the
 * browser (labels, which buttons to show). No database or server imports.
 *
 *   Request → Validation → Approval → Pickup assignment → Pickup → Inspection → Refund
 */

export const RETURN_STATUSES = [
  "RETURN_REQUESTED",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "PICKUP_ASSIGNED",
  "PICKUP_SCHEDULED",
  "RIDER_EN_ROUTE",
  "PICKUP_COMPLETED",
  "INSPECTION_PENDING",
  "APPROVED_FOR_REFUND",
  "REFUND_INITIATED",
  "REFUND_COMPLETED",
  "RETURN_CANCELLED",
] as const;

export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export const RETURN_STATUS_LABELS: Record<ReturnStatus, string> = {
  RETURN_REQUESTED: "Return requested",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PICKUP_ASSIGNED: "Pickup assigned",
  PICKUP_SCHEDULED: "Pickup scheduled",
  RIDER_EN_ROUTE: "Rider on the way",
  PICKUP_COMPLETED: "Pickup completed",
  INSPECTION_PENDING: "Inspection pending",
  APPROVED_FOR_REFUND: "Approved for refund",
  REFUND_INITIATED: "Refund initiated",
  REFUND_COMPLETED: "Refund completed",
  RETURN_CANCELLED: "Return cancelled",
};

/** Legal moves. Anything not listed is refused by the service. */
export const RETURN_TRANSITIONS: Record<ReturnStatus, readonly ReturnStatus[]> = {
  RETURN_REQUESTED: ["UNDER_REVIEW", "REJECTED", "RETURN_CANCELLED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "RETURN_CANCELLED"],
  // Approved goes to a rider, or straight to "collected" when the customer hands the goods to the shop.
  APPROVED: ["PICKUP_ASSIGNED", "PICKUP_COMPLETED", "RETURN_CANCELLED"],
  PICKUP_ASSIGNED: ["PICKUP_SCHEDULED", "RIDER_EN_ROUTE", "APPROVED", "RETURN_CANCELLED"],
  PICKUP_SCHEDULED: ["RIDER_EN_ROUTE", "APPROVED", "RETURN_CANCELLED"],
  RIDER_EN_ROUTE: ["PICKUP_COMPLETED", "APPROVED", "RETURN_CANCELLED"],
  PICKUP_COMPLETED: ["INSPECTION_PENDING"],
  INSPECTION_PENDING: ["APPROVED_FOR_REFUND", "REJECTED"],
  APPROVED_FOR_REFUND: ["REFUND_INITIATED"],
  REFUND_INITIATED: ["REFUND_COMPLETED"],
  REFUND_COMPLETED: [],
  REJECTED: [],
  RETURN_CANCELLED: [],
};

export const RETURN_TERMINAL: readonly ReturnStatus[] = ["REJECTED", "REFUND_COMPLETED", "RETURN_CANCELLED"];

/** Statuses where the return still holds the quantities it asked for. */
export function holdsQuantity(status: ReturnStatus): boolean {
  return status !== "REJECTED" && status !== "RETURN_CANCELLED";
}

export const RETURN_REASONS = [
  "DAMAGED",
  "WRONG_ITEM",
  "QUALITY_ISSUE",
  "EXPIRED",
  "MISSING_ITEM",
  "NOT_AS_DESCRIBED",
  "CHANGED_MIND",
  "OTHER",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const RETURN_REASON_LABELS: Record<ReturnReason, string> = {
  DAMAGED: "Damaged in delivery",
  WRONG_ITEM: "Wrong item received",
  QUALITY_ISSUE: "Quality issue",
  EXPIRED: "Expired or near expiry",
  MISSING_ITEM: "Item missing",
  NOT_AS_DESCRIBED: "Not as described",
  CHANGED_MIND: "Changed my mind",
  OTHER: "Something else",
};

export const RETURN_CONDITIONS = ["UNOPENED", "OPENED", "DAMAGED", "EXPIRED", "USED"] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];

export const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = {
  UNOPENED: "Unopened / sealed",
  OPENED: "Opened",
  DAMAGED: "Damaged",
  EXPIRED: "Expired",
  USED: "Used",
};

export const PICKUP_STATUSES = ["PENDING", "OFFERED", "ACCEPTED", "EN_ROUTE", "PICKED_UP", "FAILED", "CANCELLED"] as const;
export type PickupStatus = (typeof PICKUP_STATUSES)[number];
