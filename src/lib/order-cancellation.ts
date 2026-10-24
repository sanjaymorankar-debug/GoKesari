/**
 * D10 — when a customer may cancel their own order. One rule for the server
 * (orders.ts cancelOrder, aftercare/cancellation.ts quote) and the screens
 * that offer "Cancel order" (My Orders, the order page, the open-order check
 * at checkout), so the button can no longer disagree with what the server
 * allows (TC-ORD-008: no button after pickup although a goods-only cancel is
 * allowed there). Client-safe.
 *
 *   CONFIRMED                     allowed, full refund
 *   ACCEPTED / PREPARING          only with rule cancellation.customerMayCancelUntil = PREPARING
 *   READY / ASSIGNED              only with rule afterPackingCancellation (for a fee)
 *   PICKED_UP / OUT_FOR_DELIVERY  allowed, goods-only refund (delivery fee kept)
 *   FAILED / RETURNED / DISPUTED  support only
 *
 * A shop or operator cancel is not limited by this rule.
 */
import type { OrderStatus } from "@/server/db/schema";
import { ORDER_TRANSITIONS, canTransition } from "./state-machines";

export interface SelfCancelRules {
  /** Rule `cancellation.customerMayCancelUntil`. */
  customerMayCancelUntil: "CONFIRMED" | "PREPARING";
  /** Rule `afterPackingCancellation.enabled`. */
  afterPackingEnabled: boolean;
}

/** Before packing: open to the customer only when the cancellation rule says so. */
export const SELF_CANCEL_BEFORE_PACKING: readonly OrderStatus[] = ["ACCEPTED", "PREPARING"];
/** Packed, waiting for or with a rider: open only with the after-packing fee rule. */
export const SELF_CANCEL_AFTER_PACKING: readonly OrderStatus[] = ["READY", "ASSIGNED"];
/** Handled by support, never by the customer's own cancel. */
export const SELF_CANCEL_SUPPORT_ONLY: readonly OrderStatus[] = ["FAILED", "RETURNED", "DISPUTED"];
/** Not paid yet: the payment screens settle these, not the "Cancel order" button. */
export const UNPAID_ORDER_STATUSES: readonly OrderStatus[] = ["PENDING", "PAYMENT_FAILED", "WALLET_INSUFFICIENT"];

export type SelfCancelBlock = "NOT_CANCELLABLE" | "CONTACT_SUPPORT" | "BEING_PREPARED";

/** Why the customer may not cancel their own order at this status, or null when they may. */
export function selfCancelBlock(status: OrderStatus, rules: SelfCancelRules): SelfCancelBlock | null {
  if (!canTransition(status, "CANCELLED")) return "NOT_CANCELLABLE";
  if (SELF_CANCEL_SUPPORT_ONLY.includes(status)) return "CONTACT_SUPPORT";
  if (SELF_CANCEL_BEFORE_PACKING.includes(status) && rules.customerMayCancelUntil !== "PREPARING") return "BEING_PREPARED";
  if (SELF_CANCEL_AFTER_PACKING.includes(status) && !rules.afterPackingEnabled) return "BEING_PREPARED";
  return null;
}

export const SELF_CANCEL_MESSAGES: Record<Exclude<SelfCancelBlock, "NOT_CANCELLABLE">, string> = {
  CONTACT_SUPPORT: "Please contact support about this order.",
  BEING_PREPARED: "This order is already being prepared. Please contact the shop to cancel it.",
};

/** The statuses at which the customer is offered "Cancel order": every paid status the rule allows. */
export function customerCancellableStatuses(rules: SelfCancelRules): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter(
    (status) => !UNPAID_ORDER_STATUSES.includes(status) && selfCancelBlock(status, rules) === null,
  );
}
