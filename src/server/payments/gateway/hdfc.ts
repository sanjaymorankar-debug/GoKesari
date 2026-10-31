/**
 * HdfcGateway — HDFC Bank SmartGateway (Juspay "Payment Page" integration).
 * Not used unless PAYMENT_GATEWAY=HDFC and HDFC_BASE_URL / HDFC_MERCHANT_ID /
 * HDFC_API_KEY / HDFC_PAYMENT_PAGE_CLIENT_ID / HDFC_WEBHOOK_USERNAME /
 * HDFC_WEBHOOK_PASSWORD are set; isConfigured() is false otherwise.
 *
 * Endpoint shapes follow HDFC SmartGateway's API (Juspay platform). Every call
 * sends Authorization: Basic base64(API_KEY + ":") and x-merchantid; amounts
 * are rupees with two decimals:
 *  - POST /session {order_id, amount, customer_id, payment_page_client_id,
 *      action: "paymentPage", return_url, ...}  → payment_links.web (hosted page → HOSTED_URL)
 *  - GET  /orders/{order_id}                    → status CHARGED | PENDING_VBV | AUTHORIZATION_FAILED | ...
 *  - POST /orders/{order_id}/refunds (form: unique_request_id, amount) → the order, with refunds[]
 *  - Webhooks: JSON {id, date_created, event_name, content: {order}}, authenticated by
 *    HTTP Basic auth with the username / password set in the HDFC dashboard.
 *  - Return: the customer comes back to return_url with order_id, status and
 *    signature = base64(HMAC-SHA256(RESPONSE_KEY, ...)); see verifyReturnSignature.
 *    The state is never taken from it: the return page asks fetchOrder.
 *  Hosts: UAT https://smartgateway.hdfcuat.bank.in; production — the URL HDFC
 *  gives at go-live (HDFC_BASE_URL). A UAT host is refused on gokesari.com.
 *
 * SmartGateway's order_id must be under 21 alphanumeric characters, so the
 * order id sent is derived from our merchant order id (hdfcOrderId) — the
 * same input always gives the same id, so a retry is idempotent at the bank.
 *
 * UNVERIFIED (UAT keys only, no network here): the "metadata.expiryInMins"
 * session field, whether the return comes back as GET or POST (the return
 * route takes both), the exact refund status values beyond SUCCESS / PENDING /
 * FAILURE / MANUAL_REVIEW, and the webhook event names. Run the UAT checklist
 * in docs/payments-gateway-2026-10.md before switching it on anywhere.
 */
import { getEnv, isProductionSite } from "@/lib/env";
import { hmacBase64, methodKind, paise, paymentBaseUrl, readJson, rupees, safeEqual, sha256Hex } from "./common";
import {
  GatewayNotConfiguredError,
  type CreateGatewayOrderInput,
  type CreatePaymentLinkInput,
  type GatewayCustomer,
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

/** Where the bank sends the customer back; it forwards to our own return page. */
export const HDFC_RETURN_PATH = "/api/payments/hdfc/return";

interface HdfcRefund {
  id?: string;
  ref?: string;
  unique_request_id?: string;
  amount?: number;
  status?: "SUCCESS" | "PENDING" | "FAILURE" | "MANUAL_REVIEW" | string;
}

interface HdfcOrder {
  order_id: string;
  id?: string;
  status: string;
  amount?: number;
  txn_id?: string | null;
  txn_uuid?: string | null;
  payment_method_type?: string | null;
  bank_error_message?: string | null;
  refunds?: HdfcRefund[];
}

interface HdfcSession {
  status?: string;
  id?: string;
  order_id: string;
  payment_links?: { web?: string; expiry?: string };
}

/** SmartGateway's order_id for one merchant order id: "GK" + 18 hex characters. */
export function hdfcOrderId(merchantOrderId: string): string {
  return `GK${sha256Hex(merchantOrderId).slice(0, 18).toUpperCase()}`;
}

/** The return URL to give the bank: our forwarding route, carrying the page to land on. */
export function hdfcReturnUrl(returnUrl: string | undefined): string {
  const base = paymentBaseUrl();
  let path = "/";
  if (returnUrl) {
    const url = new URL(returnUrl, base);
    if (url.origin === new URL(base).origin) path = `${url.pathname}${url.search}`;
  }
  return `${base}${HDFC_RETURN_PATH}?to=${encodeURIComponent(path)}`;
}

/** An order status → ours. */
export function hdfcOrderStatus(raw: string): GatewayOrderStatus {
  switch (raw) {
    case "CHARGED":
    case "COD_INITIATED":
      return "CAPTURED";
    case "AUTHORIZED":
      return "AUTHORIZED";
    case "AUTHENTICATION_FAILED":
    case "AUTHORIZATION_FAILED":
    case "JUSPAY_DECLINED":
    case "VOIDED":
    case "VOID":
    // A payment that arrived too late and was given back by the bank: not paid.
    case "AUTO_REFUNDED":
      return "FAILED";
    // NEW, STARTED, PENDING_VBV, AUTHORIZING; PARTIAL_CHARGED stays open for support to look at.
    default:
      return "PENDING";
  }
}

function refundStatus(raw: string | undefined): GatewayRefundStatus {
  return raw === "SUCCESS" ? "SUCCESS" : raw === "FAILURE" ? "FAILED" : "PENDING";
}

function toRefund(refund: HdfcRefund, merchantRefundId: string): GatewayRefund {
  return { gatewayRefundId: refund.id ?? refund.ref ?? merchantRefundId, status: refundStatus(refund.status) };
}

export class HdfcGateway implements PaymentGateway {
  readonly name = "HDFC" as const;

  isConfigured(): boolean {
    const env = getEnv();
    const keys = Boolean(
      env.HDFC_BASE_URL &&
        env.HDFC_MERCHANT_ID &&
        env.HDFC_API_KEY &&
        env.HDFC_PAYMENT_PAGE_CLIENT_ID &&
        env.HDFC_WEBHOOK_USERNAME &&
        env.HDFC_WEBHOOK_PASSWORD,
    );
    // UAT keys never take real customers' payments.
    return keys && !(isProductionSite(env) && /uat/i.test(env.HDFC_BASE_URL!));
  }

  private async call<T>(method: "GET" | "POST", path: string, label: string, body?: { json: unknown } | { form: Record<string, string> }, customerId?: string): Promise<T> {
    if (!this.isConfigured()) throw new GatewayNotConfiguredError(this.name);
    const env = getEnv();
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${env.HDFC_API_KEY}:`).toString("base64")}`,
      "x-merchantid": env.HDFC_MERCHANT_ID!,
      Accept: "application/json",
    };
    if (customerId) headers["x-customerid"] = customerId;
    let payload: string | undefined;
    if (body && "json" in body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(body.form).toString();
    }
    const response = await fetch(`${env.HDFC_BASE_URL!.replace(/\/+$/, "")}${path}`, {
      method,
      headers,
      ...(payload !== undefined ? { body: payload } : {}),
    });
    return readJson<T>(response, `hdfc ${label}`);
  }

  private async openSession(input: {
    merchantRef: string;
    amountPaise: number;
    customer: GatewayCustomer;
    description: string;
    returnUrl: string | undefined;
    expiresAt?: Date;
  }): Promise<{ orderId: string; url: string; expiresAt: Date | null }> {
    const env = getEnv();
    const orderId = hdfcOrderId(input.merchantRef);
    const customerId = input.customer.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || orderId;
    const minutes = input.expiresAt ? Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000)) : null;
    const session = await this.call<HdfcSession>(
      "POST",
      "/session",
      "create session",
      {
        json: {
          order_id: orderId,
          amount: rupees(input.amountPaise).toFixed(2),
          currency: "INR",
          customer_id: customerId,
          ...(input.customer.email ? { customer_email: input.customer.email } : {}),
          ...(input.customer.phone ? { customer_phone: input.customer.phone } : {}),
          ...(input.customer.name ? { first_name: input.customer.name.slice(0, 50) } : {}),
          payment_page_client_id: env.HDFC_PAYMENT_PAGE_CLIENT_ID,
          action: "paymentPage",
          return_url: hdfcReturnUrl(input.returnUrl),
          description: input.description.slice(0, 255),
          ...(minutes ? { "metadata.expiryInMins": String(minutes) } : {}),
        },
      },
      customerId,
    );
    const url = session.payment_links?.web;
    if (!url) throw new Error("hdfc create session returned no payment page link.");
    const expiry = session.payment_links?.expiry ? new Date(session.payment_links.expiry) : null;
    return {
      orderId: session.order_id || orderId,
      url,
      expiresAt: expiry && !Number.isNaN(expiry.getTime()) ? expiry : (input.expiresAt ?? null),
    };
  }

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    const session = await this.openSession({
      merchantRef: input.merchantOrderId,
      amountPaise: input.amountPaise,
      customer: input.customer,
      description: input.description,
      returnUrl: input.returnUrl,
      expiresAt: input.expiresAt,
    });
    return {
      gatewayOrderId: session.orderId,
      status: "PENDING",
      checkout: { kind: "HOSTED_URL", url: session.url },
      expiresAt: session.expiresAt,
    };
  }

  private async getOrder(gatewayOrderId: string): Promise<HdfcOrder> {
    return this.call<HdfcOrder>("GET", `/orders/${encodeURIComponent(gatewayOrderId)}`, "get order");
  }

  async fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState> {
    const order = await this.getOrder(gatewayOrderId);
    const status = hdfcOrderStatus(order.status);
    return {
      gatewayOrderId: order.order_id,
      status,
      amountPaise: paise(order.amount) ?? 0,
      gatewayPaymentId: order.txn_id ?? order.txn_uuid ?? null,
      method: methodKind(order.payment_method_type),
      failureReason: status === "FAILED" ? (order.bank_error_message || order.status) : null,
    };
  }

  /** A payment link is a payment-page session sent to the customer (the same order API). */
  async createPaymentLink(input: CreatePaymentLinkInput): Promise<GatewayPaymentLink> {
    const session = await this.openSession({
      merchantRef: input.merchantLinkId,
      amountPaise: input.amountPaise,
      customer: input.customer,
      description: input.description,
      returnUrl: input.returnUrl,
      expiresAt: input.expiresAt,
    });
    return { gatewayLinkId: session.orderId, url: session.url, expiresAt: session.expiresAt ?? input.expiresAt };
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    const order = await this.call<HdfcOrder>("POST", `/orders/${encodeURIComponent(input.gatewayOrderId)}/refunds`, "create refund", {
      form: { unique_request_id: input.merchantRefundId, amount: rupees(input.amountPaise).toFixed(2) },
    });
    const refund = order.refunds?.find((r) => r.unique_request_id === input.merchantRefundId);
    // Accepted but not listed yet: still pending; fetchRefund settles it.
    return refund ? toRefund(refund, input.merchantRefundId) : { gatewayRefundId: input.merchantRefundId, status: "PENDING" };
  }

  async fetchRefund(gatewayOrderId: string, merchantRefundId: string): Promise<GatewayRefund> {
    const order = await this.getOrder(gatewayOrderId);
    const refund = order.refunds?.find((r) => r.unique_request_id === merchantRefundId);
    if (!refund) throw new Error("HDFC has no refund with this request id.");
    return toRefund(refund, merchantRefundId);
  }

  /**
   * SmartGateway authenticates webhooks with HTTP Basic auth only (no body
   * signature, no timestamp). A replay changes nothing: the event id is
   * processed once and the state always comes from fetchOrder.
   */
  verifyWebhook(_rawBody: string, headers: Headers): boolean {
    const env = getEnv();
    const header = headers.get("authorization");
    if (!env.HDFC_WEBHOOK_USERNAME || !env.HDFC_WEBHOOK_PASSWORD || !header?.startsWith("Basic ")) return false;
    const expected = Buffer.from(`${env.HDFC_WEBHOOK_USERNAME}:${env.HDFC_WEBHOOK_PASSWORD}`).toString("base64");
    return safeEqual(header.slice(6).trim(), expected);
  }

  parseWebhook(rawBody: string): GatewayWebhookEvent {
    const event = JSON.parse(rawBody) as {
      id?: string;
      date_created?: string;
      event_name?: string;
      content?: { order?: HdfcOrder };
    };
    const name = event.event_name ?? "";
    const kinds: Record<string, GatewayWebhookKind> = {
      ORDER_SUCCEEDED: "PAYMENT_CAPTURED",
      ORDER_AUTHORIZED: "PAYMENT_AUTHORIZED",
      ORDER_FAILED: "PAYMENT_FAILED",
      ORDER_AUTHENTICATION_FAILED: "PAYMENT_FAILED",
      ORDER_AUTHORIZATION_FAILED: "PAYMENT_FAILED",
      AUTO_REFUND_SUCCEEDED: "PAYMENT_FAILED",
      ORDER_REFUNDED: "REFUND_SUCCESS",
      REFUND_SUCCEEDED: "REFUND_SUCCESS",
      ORDER_REFUND_FAILED: "REFUND_FAILED",
      REFUND_FAILED: "REFUND_FAILED",
    };
    const kind = kinds[name] ?? "UNKNOWN";
    const order = event.content?.order;
    const isRefund = kind === "REFUND_SUCCESS" || kind === "REFUND_FAILED";
    // The refund this event is about: the latest one in the state the event names.
    const wanted = kind === "REFUND_SUCCESS" ? "SUCCESS" : "FAILURE";
    const refund = isRefund ? [...(order?.refunds ?? [])].reverse().find((r) => r.status === wanted && r.unique_request_id) : undefined;
    const occurred = event.date_created ? new Date(event.date_created) : null;
    return {
      eventId: event.id ?? `${name}:${order?.order_id ?? "?"}:${refund?.unique_request_id ?? order?.status ?? "?"}`,
      kind,
      merchantRef: refund?.unique_request_id ?? null,
      gatewayOrderId: order?.order_id ?? null,
      gatewayPaymentId: order?.txn_id ?? order?.txn_uuid ?? null,
      gatewayRefundId: refund ? (refund.id ?? refund.ref ?? null) : null,
      amountPaise: paise(refund?.amount ?? order?.amount),
      occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : new Date(),
      raw: event,
    };
  }
}

/**
 * The signature on the customer's return (HDFC's integration kit): every
 * parameter but signature / signature_algorithm as encodeURIComponent(key)=
 * encodeURIComponent(value), sorted, joined by "&", the whole string
 * URL-encoded once more, then base64(HMAC-SHA256(RESPONSE_KEY, that)).
 * Informational only — nothing is decided on it — so false when the key is unset.
 */
export function verifyReturnSignature(params: Record<string, string>, responseKey: string | undefined): boolean {
  const given = params.signature;
  if (!responseKey || !given) return false;
  const pairs = Object.entries(params)
    .filter(([key]) => key !== "signature" && key !== "signature_algorithm")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .sort();
  const computed = hmacBase64(responseKey, encodeURIComponent(pairs.join("&")));
  let decoded = given;
  try {
    decoded = decodeURIComponent(given);
  } catch {
    // Already decoded.
  }
  return safeEqual(computed, decoded);
}
