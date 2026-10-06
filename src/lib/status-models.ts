/**
 * Lifecycle status models for shops, riders and subscriptions (feature
 * F1). Client-safe: no database access.
 *
 * Each entity keeps its existing detailed status column unchanged (shops.status,
 * delivery_partners.status + is_online + its deliveries, subscriptions.status +
 * pause window). The lifecycle status here is a *derived* summary of those
 * fields, stored in a new `lifecycle_status` column that a database trigger
 * keeps in step on every write (migration 0042). Because the database derives
 * it, every code path — old or new — produces the same answer, and the same
 * trigger is the one place transitions are checked and logged
 * (status_changes). The transition tables below are the source of the rules
 * the migration seeds; tests assert the two never drift.
 */

export const SHOP_LIFECYCLE_STATUSES = ["PENDING", "ACTIVE", "PAUSED", "SUSPENDED", "REJECTED", "CLOSED"] as const;
export type ShopLifecycleStatus = (typeof SHOP_LIFECYCLE_STATUSES)[number];

export const RIDER_LIFECYCLE_STATUSES = [
  "ONBOARDING",
  "OFFLINE",
  "AVAILABLE",
  "BUSY",
  "ON_DELIVERY",
  "SUSPENDED",
  "REJECTED",
  "INACTIVE",
] as const;
export type RiderLifecycleStatus = (typeof RIDER_LIFECYCLE_STATUSES)[number];

export const SUBSCRIPTION_LIFECYCLE_STATUSES = ["ACTIVE", "PAUSED", "CANCELLED", "EXPIRED"] as const;
export type SubscriptionLifecycleStatus = (typeof SUBSCRIPTION_LIFECYCLE_STATUSES)[number];

export type StatusEntity = "SHOP" | "RIDER" | "SUBSCRIPTION";

/** Allowed moves. Anything not listed is refused by the database trigger. */
export const SHOP_TRANSITIONS: Record<ShopLifecycleStatus, readonly ShopLifecycleStatus[]> = {
  PENDING: ["ACTIVE", "PAUSED", "REJECTED", "SUSPENDED", "CLOSED"],
  ACTIVE: ["PAUSED", "SUSPENDED", "CLOSED", "PENDING", "REJECTED"],
  PAUSED: ["ACTIVE", "SUSPENDED", "CLOSED", "PENDING", "REJECTED"],
  SUSPENDED: ["ACTIVE", "PAUSED", "CLOSED", "PENDING", "REJECTED"],
  REJECTED: ["PENDING", "ACTIVE", "PAUSED", "CLOSED"],
  CLOSED: ["PENDING", "ACTIVE", "PAUSED"],
};

export const RIDER_TRANSITIONS: Record<RiderLifecycleStatus, readonly RiderLifecycleStatus[]> = {
  ONBOARDING: ["OFFLINE", "REJECTED", "SUSPENDED", "INACTIVE"],
  REJECTED: ["ONBOARDING", "OFFLINE", "INACTIVE"],
  OFFLINE: ["AVAILABLE", "BUSY", "ON_DELIVERY", "SUSPENDED", "INACTIVE", "ONBOARDING", "REJECTED"],
  AVAILABLE: ["OFFLINE", "BUSY", "ON_DELIVERY", "SUSPENDED", "INACTIVE"],
  BUSY: ["AVAILABLE", "OFFLINE", "ON_DELIVERY", "SUSPENDED", "INACTIVE"],
  ON_DELIVERY: ["AVAILABLE", "OFFLINE", "BUSY", "SUSPENDED", "INACTIVE"],
  SUSPENDED: ["OFFLINE", "AVAILABLE", "BUSY", "ON_DELIVERY", "INACTIVE"],
  INACTIVE: ["OFFLINE", "ONBOARDING", "SUSPENDED"],
};

/** CANCELLED and EXPIRED are final. */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionLifecycleStatus, readonly SubscriptionLifecycleStatus[]> = {
  ACTIVE: ["PAUSED", "CANCELLED", "EXPIRED"],
  PAUSED: ["ACTIVE", "CANCELLED", "EXPIRED"],
  CANCELLED: [],
  EXPIRED: [],
};

export const TRANSITIONS: Record<StatusEntity, Record<string, readonly string[]>> = {
  SHOP: SHOP_TRANSITIONS,
  RIDER: RIDER_TRANSITIONS,
  SUBSCRIPTION: SUBSCRIPTION_TRANSITIONS,
};

export function isAllowedTransition(entity: StatusEntity, from: string | null, to: string): boolean {
  if (from === null || from === to) return true;
  return (TRANSITIONS[entity][from] ?? []).includes(to);
}

/* ------------------------------------------------------------- derivation
 * Mirrors the SQL functions in migration 0042 exactly (tests check both). */

export function deriveShopLifecycle(shop: {
  status: string;
  ordersPaused: boolean;
  deletedAt: Date | null;
}): ShopLifecycleStatus {
  if (shop.deletedAt) return "CLOSED";
  switch (shop.status) {
    case "PENDING_APPROVAL":
      return "PENDING";
    case "APPROVED":
      return shop.ordersPaused ? "PAUSED" : "ACTIVE";
    case "SUSPENDED":
      return "SUSPENDED";
    case "REJECTED":
      return "REJECTED";
    default:
      return "CLOSED";
  }
}

/** activeDelivery: the rider's live delivery-order status, if any (OFFERED, ACCEPTED or PICKED_UP). */
export function deriveRiderLifecycle(rider: {
  status: string;
  isOnline: boolean;
  deletedAt: Date | null;
  activeDelivery: "OFFERED" | "ACCEPTED" | "PICKED_UP" | null;
}): RiderLifecycleStatus {
  if (rider.deletedAt || rider.status === "DEACTIVATED") return "INACTIVE";
  if (rider.status === "REGISTERED" || rider.status === "UNDER_REVIEW") return "ONBOARDING";
  if (rider.status === "REJECTED") return "REJECTED";
  if (rider.status === "SUSPENDED") return "SUSPENDED";
  if (rider.activeDelivery === "PICKED_UP") return "ON_DELIVERY";
  if (rider.activeDelivery) return "BUSY";
  return rider.isOnline ? "AVAILABLE" : "OFFLINE";
}

/** today: YYYY-MM-DD in the app timezone. */
export function deriveSubscriptionLifecycle(
  sub: { status: string; pauseFrom: string | null; pauseUntil: string | null },
  today: string,
): SubscriptionLifecycleStatus {
  if (sub.status === "CANCELLED") return "CANCELLED";
  if (sub.status === "COMPLETED") return "EXPIRED";
  if (sub.status === "PAUSED") return "PAUSED";
  if (sub.pauseFrom && sub.pauseFrom <= today && (!sub.pauseUntil || sub.pauseUntil >= today)) return "PAUSED";
  return "ACTIVE";
}

export const LIFECYCLE_LABELS: Record<string, string> = {
  PENDING: "Pending approval",
  ACTIVE: "Active",
  PAUSED: "Paused",
  SUSPENDED: "Suspended",
  REJECTED: "Rejected",
  CLOSED: "Closed",
  ONBOARDING: "Onboarding",
  OFFLINE: "Offline",
  AVAILABLE: "Available",
  BUSY: "Busy (offer pending)",
  ON_DELIVERY: "On delivery",
  INACTIVE: "Inactive",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};
