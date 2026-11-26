/**
 * CashfreeGateway — Cashfree Payment Gateway (PG API version 2023-08-01)
 * behind the PaymentGateway interface (batch-2026-10 WS-A).
 *
 * Uses the same keys and environment as the existing wallet top-up flow
 * (CASHFREE_APP_ID / CASHFREE_SECRET_KEY / CASHFREE_ENV, base URL from
 * cashfreeApiBase()); the top-up code in services/payments.ts is left as it is.
 *
 *  - createOrder        POST /orders → payment_session_id. Cashfree's checkout opens
 *                       from its JS SDK with that session, so this returns an
 *                       SDK_SESSION; our page /pay/cashfree/<intent> opens it.
 *  - fetchOrder         GET /orders/{id} (+ GET /orders/{id}/payments for the payment id,
 *                       method and the latest failure) — the server-side truth.
 *  - createPaymentLink  POST /links (gatewayLinkId is stored as "link:<link_id>").
 *  - refund             POST /orders/{id}/refunds with refund_id = our merchant refund id
 *                       (Cashfree's idempotency key); fetchRefund GET .../refunds/{refund_id}.
 *  - verifyWebhook      x-webhook-signature = base64(HMAC-SHA256(secret, x-webhook-timestamp + rawBody)),
 *                       the same check as the top-up webhook, plus a 5-minute freshness window.
 *                       Secret: PAYMENT_WEBHOOK_SECRET_CASHFREE, else CASHFREE_SECRET_KEY.
 *
 * UNVERIFIED against a live account in this environment (no network):
 *  - the payment-link event's field names (PAYMENT_LINK_EVENT) and the refund
 *    path for link payments (GET /links/{id}/orders);
 *  - whether Cashfree sends an `x-idempotency-key` header on webhooks — when it
 *    does not, the event id is derived from type + payment/refund id + status.
 * Everything else follows Cashfree's published PG reference and the fields the
 * existing top-up code already relies on.
 */
import { cashfreeApiBase, cashfreeEnvProblem, cashfreeRefundSpeed, getEnv } from "@/lib/env";
import { exactJsonId, hmacBase64, isFresh, methodKind, paise, readJson, rupees, safeEqual, sha256Hex } from "./common";
import {
  GatewayNotConfiguredError,
  type CreateGatewayOrderInput,
  type CreatePaymentLinkInput,
  type GatewayOrder,
  type GatewayOrderState,
  type GatewayOrderStatus,
  type GatewayPaymentLink,
  type GatewayRefund,
  type GatewayRefundInput,
  type GatewayRefundStatus,
  type GatewayDispute,
  type GatewayWebhookEvent,
  type GatewayWebhookKind,
  type PaymentGateway,
  type PaymentMethodKind,
} from "./types";

const API_VERSION = "2023-08-01";
const LINK_PREFIX = "link:";

// WALLET → Cashfree "app" (Paytm, PhonePe, Amazon Pay, … — whichever wallets Cashfree has switched on for the account).
const METHOD_CODES: Record<PaymentMethodKind, string> = { UPI: "upi", CARD: "cc,dc", NETBANKING: "nb", WALLET: "app" };

interface CfOrder {
  cf_order_id?: string | number;
  order_id: string;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED" | string;
  order_amount: number;
  payment_session_id?: string;
  order_expiry_time?: string;
}

interface CfPayment {
  cf_payment_id: string | number;
  payment_status: "SUCCESS" | "NOT_ATTEMPTED" | "FAILED" | "USER_DROPPED" | "VOID" | "CANCELLED" | "PENDING" | string;
  payment_amount?: number;
  payment_group?: string;
  payment_message?: string;
  payment_time?: string;
}

interface CfRefund {
  cf_refund_id?: string | number;
  refund_id: string;
  refund_status: "SUCCESS" | "PENDING" | "CANCELLED" | "ONHOLD" | string;
}

interface CfLink {
  link_id: string;
  link_status: "ACTIVE" | "PAID" | "EXPIRED" | "CANCELLED" | string;
  link_amount: number;
  link_amount_paid?: number;
  link_url: string;
  link_expiry_time?: string;
}

/**
 * docs/payments-cashfree-audit-2026-11 F17: Cashfree refuses an order whose order_expiry_time is
 * less than 15 minutes ahead. The intent's expiry is the onlinePayments rule's minutes (15 by
 * default) counted from before this call, so it always arrived just under 15 minutes and every
 * order was refused. The order now gets at least 16 minutes; the intent stores the expiry
 * Cashfree returns.
 */
export const CASHFREE_MIN_ORDER_EXPIRY_MINUTES = 16;

export function cashfreeOrderExpiryTime(expiresAt: Date, now: Date = new Date()): Date {
  const floor = now.getTime() + CASHFREE_MIN_ORDER_EXPIRY_MINUTES * 60_000;
  return expiresAt.getTime() >= floor ? expiresAt : new Date(floor);
}

function refundStatus(raw: string): GatewayRefundStatus {
  if (raw === "SUCCESS") return "SUCCESS";
  if (raw === "CANCELLED") return "FAILED";
  return "PENDING"; // PENDING, ONHOLD
}

/** Cashfree order + its payments → our status. */
export function mapCashfreeOrder(order: CfOrder, payments: CfPayment[]): GatewayOrderState {
  const success = payments.find((p) => p.payment_status === "SUCCESS");
  const latest = [...payments].sort((a, b) => String(b.payment_time ?? "").localeCompare(String(a.payment_time ?? "")))[0];
  let status: GatewayOrderStatus;
  if (order.order_status === "PAID" || success) status = "CAPTURED";
  else if (order.order_status === "EXPIRED") status = "EXPIRED";
  else if (order.order_status === "TERMINATED" || order.order_status === "TERMINATION_REQUESTED") status = "FAILED";
  else if (latest && ["FAILED", "USER_DROPPED", "CANCELLED", "VOID"].includes(latest.payment_status)) status = "FAILED";
  else if (latest && latest.payment_status === "PENDING") status = "PENDING";
  else status = "PENDING"; // ACTIVE and not attempted yet: the customer is on the checkout.
  const paid = success ?? null;
  return {
    gatewayOrderId: order.order_id,
    status,
    amountPaise: paise(paid?.payment_amount ?? order.order_amount) ?? 0,
    gatewayPaymentId: paid ? String(paid.cf_payment_id) : null,
    method: methodKind(paid?.payment_group ?? latest?.payment_group),
    failureReason: status === "FAILED" ? (latest?.payment_message ?? order.order_status) : null,
  };
}

export class CashfreeGateway implements PaymentGateway {
  readonly name = "CASHFREE" as const;

  isConfigured(): boolean {
    const env = getEnv();
    // docs/payments-cashfree-audit-2026-11: the sandbox on gokesari.com (or production on the
    // test site) counts as not configured, so no order is ever taken with the wrong money.
    return Boolean(env.CASHFREE_APP_ID && env.CASHFREE_SECRET_KEY) && !cashfreeEnvProblem("pg", env);
  }

  private headers(): Record<string, string> {
    if (!this.isConfigured()) throw new GatewayNotConfiguredError(this.name);
    const env = getEnv();
    return {
      "Content-Type": "application/json",
      "x-api-version": API_VERSION,
      "x-client-id": env.CASHFREE_APP_ID!,
      "x-client-secret": env.CASHFREE_SECRET_KEY!,
    };
  }

  private async call<T>(method: "GET" | "POST", path: string, label: string, body?: unknown): Promise<T> {
    const response = await fetch(`${cashfreeApiBase()}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return readJson<T>(response, `cashfree ${label}`);
  }

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    const order = await this.call<CfOrder>("POST", "/orders", "create order", {
      order_id: input.merchantOrderId,
      order_amount: rupees(input.amountPaise),
      order_currency: "INR",
      customer_details: {
        customer_id: input.customer.id,
        customer_email: input.customer.email ?? undefined,
        // Cashfree requires a phone; the same fallback as the top-up flow.
        customer_phone: (input.customer.phone ?? "").replace(/^\+91/, "") || "9999999999",
        customer_name: input.customer.name ?? undefined,
      },
      order_meta: {
        return_url: input.returnUrl,
        notify_url: input.notifyUrl,
        ...(input.methods?.length ? { payment_methods: input.methods.map((m) => METHOD_CODES[m]).join(",") } : {}),
      },
      ...(input.expiresAt ? { order_expiry_time: cashfreeOrderExpiryTime(input.expiresAt).toISOString() } : {}),
      order_note: input.description.slice(0, 200),
      ...(input.metadata ? { order_tags: input.metadata } : {}),
    });
    if (!order.payment_session_id) throw new Error("Cashfree did not return a payment session.");
    return {
      gatewayOrderId: order.order_id,
      status: order.order_status === "PAID" ? "CAPTURED" : "PENDING",
      checkout: { kind: "SDK_SESSION", sessionToken: order.payment_session_id },
      expiresAt: order.order_expiry_time ? new Date(order.order_expiry_time) : (input.expiresAt ?? null),
    };
  }

  async fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState> {
    if (gatewayOrderId.startsWith(LINK_PREFIX)) return this.fetchLink(gatewayOrderId.slice(LINK_PREFIX.length));
    const id = encodeURIComponent(gatewayOrderId);
    const order = await this.call<CfOrder>("GET", `/orders/${id}`, "get order");
    const payments = await this.call<CfPayment[]>("GET", `/orders/${id}/payments`, "get payments");
    return mapCashfreeOrder(order, payments);
  }

  private async fetchLink(linkId: string): Promise<GatewayOrderState> {
    const link = await this.call<CfLink>("GET", `/links/${encodeURIComponent(linkId)}`, "get link");
    const status: GatewayOrderStatus =
      link.link_status === "PAID" ? "CAPTURED" : link.link_status === "EXPIRED" ? "EXPIRED" : link.link_status === "CANCELLED" ? "FAILED" : "PENDING";
    return {
      gatewayOrderId: `${LINK_PREFIX}${link.link_id}`,
      status,
      amountPaise: paise(link.link_amount_paid ?? link.link_amount) ?? 0,
      gatewayPaymentId: null,
      method: null,
    };
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<GatewayPaymentLink> {
    const link = await this.call<CfLink>("POST", "/links", "create link", {
      link_id: input.merchantLinkId,
      link_amount: rupees(input.amountPaise),
      link_currency: "INR",
      link_purpose: input.description.slice(0, 500),
      customer_details: {
        customer_phone: (input.customer.phone ?? "").replace(/^\+91/, "") || "9999999999",
        customer_email: input.customer.email ?? undefined,
        customer_name: input.customer.name ?? undefined,
      },
      link_expiry_time: input.expiresAt.toISOString(),
      link_notify: { send_sms: false, send_email: false },
      link_meta: { notify_url: input.notifyUrl, ...(input.returnUrl ? { return_url: input.returnUrl } : {}) },
    });
    return {
      gatewayLinkId: `${LINK_PREFIX}${link.link_id}`,
      url: link.link_url,
      expiresAt: link.link_expiry_time ? new Date(link.link_expiry_time) : input.expiresAt,
    };
  }

  /** 0210: POST /links/{link_id}/cancel — an unpaid link stops accepting payments (Cashfree reports it CANCELLED). */
  async cancelPaymentLink(gatewayLinkId: string): Promise<void> {
    const id = gatewayLinkId.startsWith(LINK_PREFIX) ? gatewayLinkId.slice(LINK_PREFIX.length) : gatewayLinkId;
    await this.call<CfLink>("POST", `/links/${encodeURIComponent(id)}/cancel`, "cancel link");
  }

  /** UNVERIFIED: a link payment is refunded on the order Cashfree created for it. */
  private async refundOrderId(gatewayOrderId: string): Promise<string> {
    if (!gatewayOrderId.startsWith(LINK_PREFIX)) return gatewayOrderId;
    const orders = await this.call<{ order_id: string; order_status: string }[]>(
      "GET",
      `/links/${encodeURIComponent(gatewayOrderId.slice(LINK_PREFIX.length))}/orders`,
      "get link orders",
    );
    const paid = orders.find((o) => o.order_status === "PAID");
    if (!paid) throw new Error("No paid Cashfree order was found for this payment link.");
    return paid.order_id;
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    const orderId = await this.refundOrderId(input.gatewayOrderId);
    const refund = await this.call<CfRefund>("POST", `/orders/${encodeURIComponent(orderId)}/refunds`, "create refund", {
      refund_amount: rupees(input.amountPaise),
      refund_id: input.merchantRefundId,
      refund_note: input.reason.slice(0, 100),
      // CASHFREE_REFUND_SPEED (optional): INSTANT only once Cashfree has switched it on; unset = STANDARD.
      ...(cashfreeRefundSpeed() ? { refund_speed: cashfreeRefundSpeed() } : {}),
    });
    return { gatewayRefundId: String(refund.cf_refund_id ?? refund.refund_id), status: refundStatus(refund.refund_status) };
  }

  async fetchRefund(gatewayOrderId: string, merchantRefundId: string): Promise<GatewayRefund> {
    const orderId = await this.refundOrderId(gatewayOrderId);
    const refund = await this.call<CfRefund>(
      "GET",
      `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(merchantRefundId)}`,
      "get refund",
    );
    return { gatewayRefundId: String(refund.cf_refund_id ?? refund.refund_id), status: refundStatus(refund.refund_status) };
  }

  private webhookSecret(): string | null {
    const env = getEnv();
    return env.PAYMENT_WEBHOOK_SECRET_CASHFREE ?? env.CASHFREE_SECRET_KEY ?? null;
  }

  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = this.webhookSecret();
    const signature = headers.get("x-webhook-signature");
    const timestamp = headers.get("x-webhook-timestamp");
    if (!secret || !signature || !timestamp || !isFresh(timestamp)) return false;
    return safeEqual(hmacBase64(secret, timestamp + rawBody), signature);
  }

  parseWebhook(rawBody: string, headers: Headers): GatewayWebhookEvent {
    const dispute = parseCashfreeDispute(rawBody, headers);
    if (dispute) return dispute;
    const event = JSON.parse(rawBody) as {
      type?: string;
      event_time?: string;
      data?: {
        order?: { order_id?: string; order_amount?: number };
        payment?: { cf_payment_id?: string | number; payment_status?: string; payment_amount?: number };
        refund?: { cf_refund_id?: string | number; refund_id?: string; order_id?: string; refund_status?: string; refund_amount?: number };
        link_id?: string;
        link_status?: string;
        link_amount_paid?: number;
      };
    };
    const type = event.type ?? "";
    const data = event.data ?? {};
    let kind: GatewayWebhookKind = "UNKNOWN";
    if (type === "PAYMENT_SUCCESS_WEBHOOK") kind = "PAYMENT_CAPTURED";
    else if (type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") kind = "PAYMENT_FAILED";
    else if (type === "REFUND_STATUS_WEBHOOK") kind = data.refund?.refund_status === "SUCCESS" ? "REFUND_SUCCESS" : data.refund?.refund_status === "CANCELLED" ? "REFUND_FAILED" : "UNKNOWN";
    else if (type === "PAYMENT_LINK_EVENT") kind = data.link_status === "PAID" ? "LINK_PAID" : "UNKNOWN";

    // Exact digits from the raw body: JSON.parse rounds Cashfree's ids above 2^53.
    const paymentId = exactJsonId(rawBody, "cf_payment_id", data.payment?.cf_payment_id);
    const refundId = exactJsonId(rawBody, "cf_refund_id", data.refund?.cf_refund_id);
    const eventId =
      headers.get("x-idempotency-key") ??
      `${type}:${refundId ?? paymentId ?? data.link_id ?? data.order?.order_id ?? "?"}:${data.refund?.refund_status ?? data.payment?.payment_status ?? data.link_status ?? ""}:${sha256Hex(rawBody).slice(0, 12)}`;
    const linkRef = data.link_id ? data.link_id : null;
    return {
      eventId,
      kind,
      merchantRef: data.refund?.refund_id ?? linkRef ?? data.order?.order_id ?? null,
      gatewayOrderId: linkRef ? `${LINK_PREFIX}${linkRef}` : (data.refund?.order_id ?? data.order?.order_id ?? null),
      gatewayPaymentId: paymentId,
      gatewayRefundId: refundId,
      amountPaise: paise(data.refund?.refund_amount ?? data.payment?.payment_amount ?? data.link_amount_paid ?? data.order?.order_amount),
      occurredAt: event.event_time ? new Date(event.event_time) : new Date(),
      raw: event,
    };
  }
}

/* ------------------------------------------------------------ PAY-SM: disputes */

interface CfDisputeWebhook {
  type?: string;
  event_time?: string;
  data?: {
    dispute?: {
      dispute_id?: string | number;
      dispute_type?: string;
      reason_code?: string | number;
      reason_description?: string;
      dispute_amount?: number | string;
      created_at?: string;
      updated_at?: string;
      respond_by?: string;
      resolved_at?: string | null;
      dispute_status?: string;
    };
    order_details?: { order_id?: string; cf_payment_id?: string | number; payment_amount?: number };
  };
}

function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Cashfree's dispute status word → our outcome. Cashfree prefixes the stage (DISPUTE_, CHARGEBACK_,
 * RETRIEVAL_, PRE_ARBITRATION_, ARBITRATION_) and ends with what happened.
 */
export function cashfreeDisputeOutcome(status: string, eventType: string): GatewayDispute["outcome"] {
  const s = status.toUpperCase();
  if (s.endsWith("MERCHANT_WON")) return "WON";
  if (s.endsWith("MERCHANT_LOST") || s.endsWith("MERCHANT_ACCEPTED") || s.endsWith("INSUFFICIENT_EVIDENCE")) return "LOST";
  if (s.endsWith("_CLOSED") || eventType === "DISPUTE_CLOSED") return "CLOSED";
  return "OPEN";
}

/**
 * A Cashfree DISPUTE_CREATED / DISPUTE_UPDATED / DISPUTE_CLOSED webhook (PG API 2023-08-01), or null for
 * any other event. Field names follow Cashfree's published dispute webhook; UNVERIFIED against a live
 * dispute (none can be raised from this environment).
 */
export function parseCashfreeDispute(rawBody: string, headers: Headers): GatewayWebhookEvent | null {
  const event = JSON.parse(rawBody) as CfDisputeWebhook;
  const type = event.type ?? "";
  if (!type.startsWith("DISPUTE_")) return null;
  const d = event.data?.dispute;
  const disputeId = exactJsonId(rawBody, "dispute_id", d?.dispute_id);
  if (!d || !disputeId) throw new Error("dispute webhook without a dispute id");
  const order = event.data?.order_details ?? {};
  const gatewayStatus = d.dispute_status ?? type;
  const updatedAt = dateOrNull(d.updated_at) ?? dateOrNull(event.event_time) ?? new Date();
  const paymentId = exactJsonId(rawBody, "cf_payment_id", order.cf_payment_id);
  const dispute: GatewayDispute = {
    disputeId,
    disputeType: d.dispute_type ?? null,
    gatewayStatus,
    outcome: cashfreeDisputeOutcome(gatewayStatus, type),
    amountPaise: paise(d.dispute_amount) ?? 0,
    reasonCode: d.reason_code == null ? null : String(d.reason_code),
    reason: d.reason_description ?? null,
    respondBy: dateOrNull(d.respond_by),
    openedAt: dateOrNull(d.created_at),
    resolvedAt: dateOrNull(d.resolved_at),
    updatedAt,
  };
  return {
    // One event per (dispute, status, change time); Cashfree's own idempotency key wins when it sends one.
    eventId: headers.get("x-idempotency-key") ?? `${type}:${disputeId}:${gatewayStatus}:${updatedAt.toISOString()}`,
    kind: "DISPUTE",
    merchantRef: order.order_id ?? null,
    gatewayOrderId: order.order_id ?? null,
    gatewayPaymentId: paymentId,
    gatewayRefundId: null,
    amountPaise: dispute.amountPaise,
    occurredAt: dateOrNull(event.event_time) ?? updatedAt,
    dispute,
    raw: event,
  };
}
