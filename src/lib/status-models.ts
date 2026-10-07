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

/**
 * SM-002: a shop awaiting approval is in one of three onboarding stages, in
 * this order — KYC_PENDING (a mandatory seller document is not verified),
 * PAYMENT_PENDING (documents verified, registration fee not settled),
 * VERIFIED (both done; waiting for an operator to approve). Migration 0051
 * replaced the single PENDING stage of F1 with these three.
 */
export const SHOP_ONBOARDING_STAGES = ["KYC_PENDING", "PAYMENT_PENDING", "VERIFIED"] as const;
export type ShopOnboardingStage = (typeof SHOP_ONBOARDING_STAGES)[number];

export const SHOP_LIFECYCLE_STATUSES = [
  ...SHOP_ONBOARDING_STAGES,
  "ACTIVE",
  "PAUSED",
  "SUSPENDED",
  "REJECTED",
  "CLOSED",
] as const;
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

/**
 * SM-004 added DRAFT (saved, not started — nothing is generated or charged)
 * and RENEWAL_PENDING (the term is about to end, or the wallet will not cover
 * the next delivery; deliveries continue until the end date). Migration 0052.
 */
export const SUBSCRIPTION_LIFECYCLE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "RENEWAL_PENDING", "CANCELLED", "EXPIRED"] as const;
export type SubscriptionLifecycleStatus = (typeof SUBSCRIPTION_LIFECYCLE_STATUSES)[number];

export type StatusEntity = "SHOP" | "RIDER" | "SUBSCRIPTION";

/** Allowed moves. Anything not listed is refused by the database trigger. */
/*
 * Shops: the onboarding stages move freely among themselves (a document can
 * expire, a fee can be refunded), but only VERIFIED can go live — approval
 * from KYC_PENDING or PAYMENT_PENDING is refused here and in approveShop().
 * Every other move is the F1 set with PENDING read as "any onboarding stage";
 * REJECTED → ACTIVE stays (approving a rejected shop directly, as before), and
 * approveShop() checks documents and fee for that path too.
 */
const ONBOARDING = SHOP_ONBOARDING_STAGES;
const otherStages = (s: ShopOnboardingStage) => ONBOARDING.filter((x) => x !== s);
export const SHOP_TRANSITIONS: Record<ShopLifecycleStatus, readonly ShopLifecycleStatus[]> = {
  KYC_PENDING: [...otherStages("KYC_PENDING"), "REJECTED", "SUSPENDED", "CLOSED"],
  PAYMENT_PENDING: [...otherStages("PAYMENT_PENDING"), "REJECTED", "SUSPENDED", "CLOSED"],
  VERIFIED: [...otherStages("VERIFIED"), "ACTIVE", "PAUSED", "REJECTED", "SUSPENDED", "CLOSED"],
  ACTIVE: ["PAUSED", "SUSPENDED", "CLOSED", ...ONBOARDING, "REJECTED"],
  PAUSED: ["ACTIVE", "SUSPENDED", "CLOSED", ...ONBOARDING, "REJECTED"],
  SUSPENDED: ["ACTIVE", "PAUSED", "CLOSED", ...ONBOARDING, "REJECTED"],
  REJECTED: [...ONBOARDING, "ACTIVE", "PAUSED", "CLOSED"],
  CLOSED: [...ONBOARDING, "ACTIVE", "PAUSED"],
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

/** CANCELLED and EXPIRED are final; nothing returns to DRAFT. */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionLifecycleStatus, readonly SubscriptionLifecycleStatus[]> = {
  DRAFT: ["ACTIVE", "PAUSED", "RENEWAL_PENDING", "CANCELLED"],
  ACTIVE: ["PAUSED", "RENEWAL_PENDING", "CANCELLED", "EXPIRED"],
  PAUSED: ["ACTIVE", "RENEWAL_PENDING", "CANCELLED", "EXPIRED"],
  RENEWAL_PENDING: ["ACTIVE", "PAUSED", "CANCELLED", "EXPIRED"],
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

/**
 * The onboarding stage of a shop awaiting approval: documents first, then the
 * fee. `kycComplete` = every mandatory seller document VERIFIED (see
 * seller-verification-checks.ts requirementFor; SQL: shop_kyc_complete).
 */
export function deriveShopOnboardingStage(shop: { feePaymentStatus: string; kycComplete: boolean }): ShopOnboardingStage {
  if (!shop.kycComplete) return "KYC_PENDING";
  if (shop.feePaymentStatus !== "PAID") return "PAYMENT_PENDING";
  return "VERIFIED";
}

export function deriveShopLifecycle(shop: {
  status: string;
  ordersPaused: boolean;
  deletedAt: Date | null;
  feePaymentStatus: string;
  kycComplete: boolean;
}): ShopLifecycleStatus {
  if (shop.deletedAt) return "CLOSED";
  switch (shop.status) {
    case "PENDING_APPROVAL":
      return deriveShopOnboardingStage(shop);
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
  if (sub.status === "DRAFT") return "DRAFT";
  if (sub.status === "CANCELLED") return "CANCELLED";
  if (sub.status === "COMPLETED") return "EXPIRED";
  if (sub.status === "PAUSED") return "PAUSED";
  if (sub.pauseFrom && sub.pauseFrom <= today && (!sub.pauseUntil || sub.pauseUntil >= today)) return "PAUSED";
  if (sub.status === "RENEWAL_PENDING") return "RENEWAL_PENDING";
  return "ACTIVE";
}

export const LIFECYCLE_LABELS: Record<string, string> = {
  /** Shops before migration 0051 (still in the change log). */
  PENDING: "Pending approval",
  KYC_PENDING: "KYC pending",
  PAYMENT_PENDING: "Payment pending",
  VERIFIED: "Verified — awaiting approval",
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
  DRAFT: "Draft",
  RENEWAL_PENDING: "Renewal pending",
};
