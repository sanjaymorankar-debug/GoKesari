/**
 * Payment intents — one gateway payment for one purpose (an order, a shop's
 * registration fee, ...), with the state machine
 *
 *   CREATED → PENDING → AUTHORIZED → CAPTURED → PARTIALLY_REFUNDED → REFUNDED
 *          ↘ FAILED / EXPIRED
 *
 * batch-2026-10 contract. Workstream A (payments) owns this file and replaces
 * the stub bodies below; other workstreams only import these signatures.
 */
import type { DbClient } from "@/server/db";
import type { GatewayCheckout, GatewayCustomer, GatewayName } from "./gateway/types";

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
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/** What a payment is for. Each purpose's capture handler lives in purpose-handlers.ts. */
export type PaymentPurpose = "ORDER" | "ORDER_GROUP" | "SHOP_REGISTRATION_FEE";

export interface PaymentIntentRef {
  id: string;
  purpose: PaymentPurpose;
  /** The order id, order-group id or shop id the payment is for. */
  referenceId: string;
  userId: string | null;
  amountPaise: number;
  refundedPaise: number;
  status: PaymentIntentStatus;
  gateway: GatewayName;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
}

export interface CreatePaymentIntentInput {
  purpose: PaymentPurpose;
  referenceId: string;
  userId: string | null;
  amountPaise: number;
  customer: GatewayCustomer;
  description: string;
  /** Same key → same intent: a customer can never be charged twice for one order. */
  idempotencyKey: string;
  /** CHECKOUT: hosted page / SDK now. LINK: a payment link to send (e.g. to a shop owner). */
  mode: "CHECKOUT" | "LINK";
  returnPath?: string;
}

export interface CreatedPaymentIntent {
  intent: PaymentIntentRef;
  checkout: GatewayCheckout | null;
  linkUrl: string | null;
}

export interface RefundPaymentIntentInput {
  intentId: string;
  amountPaise: number;
  reason: string;
  /** One refund per key. */
  idempotencyKey: string;
}

export interface PaymentRefundRef {
  id: string;
  intentId: string;
  amountPaise: number;
  status: "PENDING" | "SUCCESS" | "FAILED";
}

function notBuilt(): never {
  throw new Error("payments/intents: not implemented yet (workstream A).");
}

export async function createPaymentIntent(_input: CreatePaymentIntentInput, _client?: DbClient): Promise<CreatedPaymentIntent> {
  notBuilt();
}

export async function getPaymentIntent(_id: string, _client?: DbClient): Promise<PaymentIntentRef | null> {
  notBuilt();
}

/** The latest CAPTURED (or partly refunded) intent for a purpose + reference, if any. */
export async function findCapturedIntent(
  _purpose: PaymentPurpose,
  _referenceId: string,
  _client?: DbClient,
): Promise<PaymentIntentRef | null> {
  notBuilt();
}

/** Refund to the original method through the gateway; moves the intent to PARTIALLY_REFUNDED / REFUNDED. */
export async function refundPaymentIntent(_input: RefundPaymentIntentInput, _client?: DbClient): Promise<PaymentRefundRef> {
  notBuilt();
}
