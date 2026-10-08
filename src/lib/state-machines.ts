/**
 * The one registry of status machines (event layer, docs/event-driven-2026-10).
 *
 * Every status change that goes through `emitEvent` is checked against the
 * table for its subject here, so an order, a delivery, a seller document and a
 * dispute case each have exactly one definition of what may follow what.
 * Services keep their own row-locked writes; they read the same tables.
 *
 * Client-safe: no database or server imports beyond types.
 */
import type { DeliveryOrderStatus, OrderStatus } from "@/server/db/schema";
import type { SellerVerificationStatus } from "./kyc/doc-formats";
import { DISPUTE_TRANSITIONS, type DisputeStatus } from "./dispute-states";

/**
 * The approved order state machine (see the orderStatusEnum doc comment in
 * schema.ts for the mapping to DRAFT/PAYMENT_PENDING/PAID/SHOP_PENDING).
 *
 * Kept compatible with what already worked:
 *  - CONFIRMED -> PREPARING stays legal (subscription orders and the older
 *    one-click "Start preparing" path); ACCEPTED is the explicit step.
 *  - READY -> OUT_FOR_DELIVERY / DELIVERED stays legal for shops that deliver
 *    themselves or hand over in store. Once a rider accepts (ASSIGNED), only
 *    the rider flow (pickup code -> OTP) can move the order on.
 *  - ASSIGNED -> READY lets a reassignment put the order back in the queue.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["CONFIRMED", "CANCELLED", "PAYMENT_FAILED", "WALLET_INSUFFICIENT"],
  WALLET_INSUFFICIENT: ["CONFIRMED", "CANCELLED"],
  PAYMENT_FAILED: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["ACCEPTED", "PREPARING", "CANCELLED", "REFUND_PENDING"],
  ACCEPTED: ["PREPARING", "CANCELLED", "REFUND_PENDING"],
  PREPARING: ["READY", "CANCELLED", "REFUND_PENDING"],
  READY: ["ASSIGNED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "REFUND_PENDING"],
  ASSIGNED: ["READY", "PICKED_UP", "CANCELLED", "REFUND_PENDING"],
  PICKED_UP: ["OUT_FOR_DELIVERY", "FAILED", "CANCELLED", "REFUND_PENDING"],
  OUT_FOR_DELIVERY: ["DELIVERED", "FAILED", "CANCELLED", "REFUND_PENDING"],
  FAILED: ["OUT_FOR_DELIVERY", "RETURNED", "CANCELLED", "REFUND_PENDING"],
  RETURNED: ["CANCELLED", "REFUND_PENDING"],
  DELIVERED: ["DISPUTED", "REFUND_PENDING"],
  DISPUTED: ["DELIVERED", "REFUND_PENDING"],
  CANCELLED: ["REFUND_PENDING"],
  REFUND_PENDING: ["REFUNDED"],
  REFUNDED: [],
};

/**
 * A rider assignment (delivery_orders). One row per order, reused when the
 * order is offered again: a declined, expired or cancelled offer goes back to
 * OFFERED for the next rider. A started drop is not a status of its own — it
 * is `out_for_delivery_at` on a PICKED_UP row.
 */
export const DELIVERY_TRANSITIONS: Record<DeliveryOrderStatus, readonly DeliveryOrderStatus[]> = {
  OFFERED: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PICKED_UP", "CANCELLED"],
  PICKED_UP: ["DELIVERED", "FAILED", "CANCELLED"],
  REJECTED: ["OFFERED"],
  CANCELLED: ["OFFERED"],
  DELIVERED: [],
  FAILED: [],
};

/**
 * A seller document check. A seller may resubmit at any time, the vendor may
 * report any result for a number (an expired licence comes back EXPIRED on
 * first submission), and the daily sweep re-checks verified numbers — so any
 * result may follow any other. What is ruled out is going back to "not
 * submitted": a submitted document is never un-submitted.
 */
const ANY_SELLER_RESULT = ["PENDING", "VERIFIED", "FAILED", "MANUAL_REVIEW", "EXPIRED"] as const satisfies readonly SellerVerificationStatus[];
export const SELLER_VERIFICATION_TRANSITIONS: Record<SellerVerificationStatus, readonly SellerVerificationStatus[]> = {
  NOT_SUBMITTED: ANY_SELLER_RESULT,
  PENDING: ANY_SELLER_RESULT,
  MANUAL_REVIEW: ANY_SELLER_RESULT,
  VERIFIED: ANY_SELLER_RESULT,
  FAILED: ANY_SELLER_RESULT,
  EXPIRED: ANY_SELLER_RESULT,
};

export const STATE_MACHINES = {
  order: ORDER_TRANSITIONS,
  delivery: DELIVERY_TRANSITIONS,
  seller_verification: SELLER_VERIFICATION_TRANSITIONS,
  dispute: DISPUTE_TRANSITIONS,
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type MachineKind = keyof typeof STATE_MACHINES;

export type MachineStatus<K extends MachineKind> = K extends "order"
  ? OrderStatus
  : K extends "delivery"
    ? DeliveryOrderStatus
    : K extends "seller_verification"
      ? SellerVerificationStatus
      : DisputeStatus;

/**
 * Whether `to` may follow `from`. A `from` of null is a new subject (its first
 * status); any known status may start a subject.
 */
export function canMove<K extends MachineKind>(kind: K, from: MachineStatus<K> | null, to: MachineStatus<K>): boolean {
  const table = STATE_MACHINES[kind] as Record<string, readonly string[]>;
  if (!(to in table)) return false;
  if (from === null) return true;
  return table[from]?.includes(to) ?? false;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return canMove("order", from, to);
}
