/**
 * RazorpayGateway — SCAFFOLD (batch-2026-10 WS-A). Not used unless
 * PAYMENT_GATEWAY=RAZORPAY and RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET /
 * PAYMENT_WEBHOOK_SECRET_RAZORPAY are set; isConfigured() is false otherwise.
 *
 * Endpoint shapes follow Razorpay's published REST API v1 (Basic auth with
 * key_id:key_secret, amounts in paise):
 *  - POST /v1/orders {amount, currency, receipt, notes}          → order id; the checkout is
 *    Razorpay's JS (Standard Checkout) opened with that order id → SDK_SESSION.
 *  - GET  /v1/orders/{id} (status created|attempted|paid) + GET /v1/orders/{id}/payments
 *  - POST /v1/payment_links {amount, currency, reference_id, expire_by, callback_url, ...} → short_url
 *  - POST /v1/payments/{payment_id}/refund {amount, receipt, notes}; GET /v1/payments/{payment_id}/refunds
 *  - Webhooks: X-Razorpay-Signature = hex(HMAC-SHA256(webhook secret, raw body));
 *    X-Razorpay-Event-Id is the event id.
 *
 * UNVERIFIED (no Razorpay account or network here): the exact refund-status
 * values beyond processed / pending / failed, how `receipt` is echoed on a
 * refund (used as our merchant refund id), and the payment-link webhook
 * payload layout. Razorpay webhooks carry no timestamp header, so replay
 * protection relies on the event id being processed once.
 * Verify all of these in Razorpay's test mode before switching it on.
 */
import { getEnv } from "@/lib/env";
import { hmacHex, methodKind, readJson, safeEqual } from "./common";
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
  type GatewayWebhookEvent,
  type GatewayWebhookKind,
  type PaymentGateway,
} from "./types";

const API = "https://api.razorpay.com/v1";
const LINK_PREFIX = "plink:";

interface RzpOrder {
  id: string;
  amount: number;
  status: "created" | "attempted" | "paid" | string;
}
interface RzpPayment {
  id: string;
  amount: number;
  status: "created" | "authorized" | "captured" | "refunded" | "failed" | string;
  method?: string;
  error_description?: string | null;
  created_at?: number;
}
interface RzpRefund {
  id: string;
  receipt?: string | null;
  status: "pending" | "processed" | "failed" | string;
}

function refundStatus(raw: string): GatewayRefundStatus {
  return raw === "processed" ? "SUCCESS" : raw === "failed" ? "FAILED" : "PENDING";
}

export class RazorpayGateway implements PaymentGateway {
  readonly name = "RAZORPAY" as const;

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET && env.PAYMENT_WEBHOOK_SECRET_RAZORPAY);
  }

  private async call<T>(method: "GET" | "POST", path: string, label: string, body?: unknown): Promise<T> {
    if (!this.isConfigured()) throw new GatewayNotConfiguredError(this.name);
    const env = getEnv();
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return readJson<T>(response, `razorpay ${label}`);
  }

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    const order = await this.call<RzpOrder>("POST", "/orders", "create order", {
      amount: input.amountPaise,
      currency: "INR",
      receipt: input.merchantOrderId.slice(0, 40),
      notes: { merchantOrderId: input.merchantOrderId, ...(input.metadata ?? {}) },
    });
    return {
      gatewayOrderId: order.id,
      status: order.status === "paid" ? "CAPTURED" : "PENDING",
      // The browser opens Razorpay Checkout with key_id + this order id.
      checkout: { kind: "SDK_SESSION", sessionToken: order.id },
      expiresAt: input.expiresAt ?? null,
    };
  }

  async fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState> {
    if (gatewayOrderId.startsWith(LINK_PREFIX)) {
      const link = await this.call<{ id: string; status: string; amount: number; amount_paid?: number; payments?: { payment_id: string }[] }>(
        "GET",
        `/payment_links/${encodeURIComponent(gatewayOrderId.slice(LINK_PREFIX.length))}`,
        "get link",
      );
      const status: GatewayOrderStatus =
        link.status === "paid" ? "CAPTURED" : link.status === "expired" ? "EXPIRED" : link.status === "cancelled" ? "FAILED" : "PENDING";
      return {
        gatewayOrderId,
        status,
        amountPaise: link.amount_paid || link.amount,
        gatewayPaymentId: link.payments?.[0]?.payment_id ?? null,
        method: null,
      };
    }
    const id = encodeURIComponent(gatewayOrderId);
    const order = await this.call<RzpOrder>("GET", `/orders/${id}`, "get order");
    const { items } = await this.call<{ items: RzpPayment[] }>("GET", `/orders/${id}/payments`, "get payments");
    const captured = items.find((p) => p.status === "captured" || p.status === "refunded");
    const authorized = items.find((p) => p.status === "authorized");
    const latest = [...items].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0];
    const status: GatewayOrderStatus =
      order.status === "paid" || captured ? "CAPTURED" : authorized ? "AUTHORIZED" : latest?.status === "failed" ? "FAILED" : "PENDING";
    const payment = captured ?? authorized ?? latest ?? null;
    return {
      gatewayOrderId: order.id,
      status,
      amountPaise: payment?.amount ?? order.amount,
      gatewayPaymentId: captured?.id ?? authorized?.id ?? null,
      method: methodKind(payment?.method),
      failureReason: status === "FAILED" ? (latest?.error_description ?? "failed") : null,
    };
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<GatewayPaymentLink> {
    const link = await this.call<{ id: string; short_url: string; expire_by?: number }>("POST", "/payment_links", "create link", {
      amount: input.amountPaise,
      currency: "INR",
      reference_id: input.merchantLinkId.slice(0, 40),
      description: input.description.slice(0, 2048),
      expire_by: Math.floor(input.expiresAt.getTime() / 1000),
      customer: { name: input.customer.name ?? undefined, email: input.customer.email ?? undefined, contact: input.customer.phone ?? undefined },
      notify: { sms: false, email: false },
      ...(input.returnUrl ? { callback_url: input.returnUrl, callback_method: "get" } : {}),
    });
    return {
      gatewayLinkId: `${LINK_PREFIX}${link.id}`,
      url: link.short_url,
      expiresAt: link.expire_by ? new Date(link.expire_by * 1000) : input.expiresAt,
    };
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    if (!input.gatewayPaymentId) throw new Error("Razorpay refunds need the payment id.");
    const refund = await this.call<RzpRefund>("POST", `/payments/${encodeURIComponent(input.gatewayPaymentId)}/refund`, "create refund", {
      amount: input.amountPaise,
      receipt: input.merchantRefundId,
      notes: { reason: input.reason.slice(0, 255) },
    });
    return { gatewayRefundId: refund.id, status: refundStatus(refund.status) };
  }

  async fetchRefund(gatewayOrderId: string, merchantRefundId: string): Promise<GatewayRefund> {
    const state = await this.fetchOrder(gatewayOrderId);
    if (!state.gatewayPaymentId) throw new Error("No captured Razorpay payment for this order.");
    const { items } = await this.call<{ items: RzpRefund[] }>(
      "GET",
      `/payments/${encodeURIComponent(state.gatewayPaymentId)}/refunds`,
      "list refunds",
    );
    const refund = items.find((r) => r.receipt === merchantRefundId);
    if (!refund) throw new Error("Razorpay has no refund with this receipt.");
    return { gatewayRefundId: refund.id, status: refundStatus(refund.status) };
  }

  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = getEnv().PAYMENT_WEBHOOK_SECRET_RAZORPAY;
    const signature = headers.get("x-razorpay-signature");
    if (!secret || !signature) return false;
    return safeEqual(hmacHex(secret, rawBody), signature);
  }

  parseWebhook(rawBody: string, headers: Headers): GatewayWebhookEvent {
    const event = JSON.parse(rawBody) as {
      event?: string;
      created_at?: number;
      payload?: {
        payment?: { entity?: { id?: string; order_id?: string; amount?: number; notes?: Record<string, string> } };
        order?: { entity?: { id?: string; amount?: number; receipt?: string } };
        refund?: { entity?: { id?: string; payment_id?: string; amount?: number; receipt?: string } };
        payment_link?: { entity?: { id?: string; reference_id?: string; amount_paid?: number } };
      };
    };
    const name = event.event ?? "";
    const kinds: Record<string, GatewayWebhookKind> = {
      "payment.authorized": "PAYMENT_AUTHORIZED",
      "payment.captured": "PAYMENT_CAPTURED",
      "order.paid": "PAYMENT_CAPTURED",
      "payment.failed": "PAYMENT_FAILED",
      "payment_link.paid": "LINK_PAID",
      "payment_link.expired": "ORDER_EXPIRED",
      "refund.processed": "REFUND_SUCCESS",
      "refund.failed": "REFUND_FAILED",
    };
    const p = event.payload ?? {};
    const link = p.payment_link?.entity;
    return {
      eventId: headers.get("x-razorpay-event-id") ?? `${name}:${p.refund?.entity?.id ?? p.payment?.entity?.id ?? link?.id ?? "?"}`,
      kind: kinds[name] ?? "UNKNOWN",
      merchantRef: p.refund?.entity?.receipt ?? link?.reference_id ?? p.order?.entity?.receipt ?? p.payment?.entity?.notes?.merchantOrderId ?? null,
      gatewayOrderId: link?.id ? `${LINK_PREFIX}${link.id}` : (p.payment?.entity?.order_id ?? p.order?.entity?.id ?? null),
      gatewayPaymentId: p.payment?.entity?.id ?? p.refund?.entity?.payment_id ?? null,
      gatewayRefundId: p.refund?.entity?.id ?? null,
      amountPaise: p.refund?.entity?.amount ?? p.payment?.entity?.amount ?? link?.amount_paid ?? p.order?.entity?.amount ?? null,
      occurredAt: event.created_at ? new Date(event.created_at * 1000) : new Date(),
      raw: event,
    };
  }
}
