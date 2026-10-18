/**
 * Payment-intent vocabulary (batch-2026-10, F1.8.4 / SM-005) — shared by the
 * server (state machine, schema) and the browser (labels on the payment
 * return page). No database or server imports, the same contract as
 * dispute-states.ts.
 *
 *   CREATED → PENDING → AUTHORIZED → CAPTURED → PARTIALLY_REFUNDED → REFUNDED
 *      │         │          │
 *      └─────────┴──────────┴──→ FAILED / EXPIRED   (terminal)
 *
 * A gateway may report a later state directly (e.g. CREATED → CAPTURED when
 * the "pending" notification never reached us), so every forward skip is
 * legal; nothing ever moves backwards, and the terminal states stay put.
 */

export const PAYMENT_INTENT_STATUSES = [
  "CREATED",
  "PENDING",
  "AUTHORIZED",
  "CAPTURED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "FAILED",
  "EXPIRED",
] as const;
export type PaymentIntentStatusValue = (typeof PAYMENT_INTENT_STATUSES)[number];

export const PAYMENT_PURPOSES = ["ORDER", "ORDER_GROUP", "SHOP_REGISTRATION_FEE"] as const;

export const PAYMENT_GATEWAYS = ["SANDBOX", "CASHFREE", "RAZORPAY", "PHONEPE"] as const;

export const PAYMENT_REFUND_STATUSES = ["PENDING", "SUCCESS", "FAILED"] as const;

export const PAYMENT_INTENT_TRANSITIONS: Record<PaymentIntentStatusValue, readonly PaymentIntentStatusValue[]> = {
  CREATED: ["PENDING", "AUTHORIZED", "CAPTURED", "FAILED", "EXPIRED"],
  PENDING: ["AUTHORIZED", "CAPTURED", "FAILED", "EXPIRED"],
  AUTHORIZED: ["CAPTURED", "FAILED", "EXPIRED"],
  CAPTURED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  // A second partial refund keeps the intent partly refunded.
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  REFUNDED: [],
  FAILED: [],
  EXPIRED: [],
};

/** Still waiting for the customer / gateway: a new attempt must not be started next to one of these. */
export const LIVE_PAYMENT_INTENT_STATUSES: readonly PaymentIntentStatusValue[] = ["CREATED", "PENDING", "AUTHORIZED"];

/** Money was taken (and may have been partly or fully given back). */
export const PAID_PAYMENT_INTENT_STATUSES: readonly PaymentIntentStatusValue[] = ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"];

export const PAYMENT_INTENT_STATUS_LABELS: Record<PaymentIntentStatusValue, string> = {
  CREATED: "Waiting for payment",
  PENDING: "Payment in progress",
  AUTHORIZED: "Payment authorised",
  CAPTURED: "Paid",
  PARTIALLY_REFUNDED: "Paid — partly refunded",
  REFUNDED: "Refunded",
  FAILED: "Payment failed",
  EXPIRED: "Payment expired",
};
