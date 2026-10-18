/**
 * F6.1.3 / F6.2.3 — the customer's cancellation, shown before they confirm.
 *
 *   GET  /api/orders/[id]/cancellation-quote → quoteCancellation()
 *        may I cancel, what is kept and why, what comes back, where it can go
 *   POST /api/orders/[id]/cancel             → cancelOrderWithChoice()
 *        cancels (orders.ts cancelOrder, under the row lock, re-checking the
 *        amount the customer saw) and starts a gateway refund when chosen
 */
import { eq } from "drizzle-orm";

import { conflict, forbidden, notFound } from "@/lib/errors";
import { canTransition } from "@/lib/state-machines";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders, shops, type OrderStatus, type UserRole } from "@/server/db/schema";
import { cancelOrder, ORDER_STATUS_LABELS } from "@/server/services/orders";
import { getRule } from "@/server/services/settings";
import { afterPackingCancellationOpen } from "./cancellation-fee";
import {
  computeRefundBreakdown,
  findRefundForCancellation,
  paymentChannelFor,
  processOriginalRefund,
  refundMethodsFor,
  type RefundBreakdown,
  type RefundMethod,
} from "./refunds";

interface Actor {
  id: string;
  role: UserRole;
}

export interface RefundMethodOption {
  method: RefundMethod;
  label: string;
  detail: string;
}

export interface CancellationQuote {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  statusLabel: string;
  selfService: boolean;
  allowed: boolean;
  blockedReason: string | null;
  breakdown: RefundBreakdown;
  refundMethods: RefundMethodOption[];
  defaultMethod: RefundMethod | null;
}

const METHOD_TEXT: Record<RefundMethod, Omit<RefundMethodOption, "method">> = {
  WALLET: { label: "GoKesari wallet", detail: "Instant — ready to use straight away." },
  ORIGINAL: { label: "Original payment method", detail: "Through the payment gateway; usually 5–7 working days to reach your bank." },
};

/** Loads the order and decides whether the actor is its customer (self-service) or shop/support. */
async function resolveActorFor(orderId: string, actor: Actor) {
  const order = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
  if (!order) throw notFound("Order");
  if (order.userId === actor.id) {
    if (!can(actor.role, PERMISSIONS.ORDER_CANCEL_OWN)) throw forbidden("You do not have permission to cancel orders.");
    return { order, selfService: true };
  }
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, order.shopId));
  if (shop?.ownerId === actor.id || can(actor.role, PERMISSIONS.ORDER_UPDATE_STATUS_ANY)) return { order, selfService: false };
  // Not the buyer, not the shop, not support: the order does not exist for them.
  throw notFound("Order");
}

/** Mirrors cancelOrder's own checks (D10 and the rules) so the screen never offers what the server refuses. */
async function blockedReasonFor(status: OrderStatus, selfService: boolean): Promise<string | null> {
  if (!canTransition(status, "CANCELLED")) return `This order is ${ORDER_STATUS_LABELS[status].toLowerCase()} and can no longer be cancelled.`;
  if (!selfService) return null;
  if ((["FAILED", "RETURNED", "DISPUTED"] as OrderStatus[]).includes(status)) return "Please contact support about this order.";
  const beforePacking = (["ACCEPTED", "PREPARING"] as OrderStatus[]).includes(status);
  if (beforePacking && (await getRule("cancellation")).customerMayCancelUntil !== "PREPARING") {
    return "This order is already being prepared. Please contact the shop to cancel it.";
  }
  if ((["READY", "ASSIGNED"] as OrderStatus[]).includes(status) && !(await afterPackingCancellationOpen(status))) {
    return "This order is already being prepared. Please contact the shop to cancel it.";
  }
  return null;
}

export async function quoteCancellation(orderId: string, actor: Actor): Promise<CancellationQuote> {
  const { order, selfService } = await resolveActorFor(orderId, actor);
  const { channel } = await paymentChannelFor(order);
  const breakdown = await computeRefundBreakdown(order, { selfService, channel });
  const blockedReason = await blockedReasonFor(order.status, selfService);
  const methods = breakdown.paid && breakdown.refundPaise > 0 ? await refundMethodsFor(channel) : [];
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status],
    selfService,
    allowed: blockedReason === null,
    blockedReason,
    breakdown,
    refundMethods: methods.map((method) => ({ method, ...METHOD_TEXT[method] })),
    defaultMethod: methods[0] ?? null,
  };
}

export interface CancelWithChoiceInput {
  reason?: string | null;
  refundMethod?: RefundMethod;
  /** The refund the customer saw on the quote; refused (409) if it has changed. */
  expectedRefundPaise?: number;
}

export async function cancelOrderWithChoice(orderId: string, actor: Actor, input: CancelWithChoiceInput) {
  const quote = await quoteCancellation(orderId, actor);
  if (!quote.allowed) throw conflict(quote.blockedReason ?? "This order cannot be cancelled.");
  if (input.refundMethod && quote.refundMethods.length > 0 && !quote.refundMethods.some((m) => m.method === input.refundMethod)) {
    throw conflict("That refund option is not available for this order.");
  }
  const reason =
    input.reason?.trim() || (quote.selfService ? "Cancelled by the customer" : "Cancelled by the shop or support");
  const result = await cancelOrder(orderId, actor, reason, {
    selfService: quote.selfService,
    refundMethod: quote.refundMethods.length > 0 ? (input.refundMethod ?? quote.defaultMethod ?? undefined) : undefined,
    expectedRefundPaise: input.expectedRefundPaise,
  });
  let refund = await findRefundForCancellation(orderId);
  if (refund?.method === "ORIGINAL" && refund.status === "REQUESTED") {
    refund = await processOriginalRefund(refund.id);
  }
  const [after] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  return {
    order: { id: result.id, orderNumber: result.orderNumber, status: after?.status ?? result.status },
    refund: refund
      ? { id: refund.id, method: refund.method, status: refund.status, amountPaise: refund.amountPaise, deductionsPaise: refund.deductionsPaise }
      : null,
  };
}
