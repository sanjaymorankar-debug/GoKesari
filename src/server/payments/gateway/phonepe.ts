/**
 * PhonePeGateway — SCAFFOLD (batch-2026-10 WS-A). Not used unless
 * PAYMENT_GATEWAY=PHONEPE and PHONEPE_MERCHANT_ID / PHONEPE_SALT_KEY /
 * PHONEPE_SALT_INDEX are set; isConfigured() is false otherwise.
 *
 * Follows PhonePe's PG "Standard Checkout" v1 (salt-key checksum):
 *  - POST {host}/pg/v1/pay        body {request: base64(json)}, header
 *      X-VERIFY = sha256(base64 + "/pg/v1/pay" + saltKey) + "###" + saltIndex
 *      → data.instrumentResponse.redirectInfo.url  (hosted page → HOSTED_URL)
 *  - GET  {host}/pg/v1/status/{merchantId}/{merchantTransactionId}
 *      X-VERIFY = sha256(path + saltKey) + "###" + saltIndex, X-MERCHANT-ID
 *      → code PAYMENT_SUCCESS | PAYMENT_ERROR | PAYMENT_PENDING | ...
 *  - POST {host}/pg/v1/refund     (same checksum shape) — refund id = our merchant refund id
 *  - Callback: body {response: base64(json)}, header X-VERIFY = sha256(response + saltKey) + "###" + saltIndex
 *  Hosts: sandbox https://api-preprod.phonepe.com/apis/pg-sandbox, production https://api.phonepe.com/apis/hermes
 *
 * UNVERIFIED (no PhonePe account or network here): PhonePe has been moving
 * merchants to a newer OAuth-based "PG v2" API — confirm which one the
 * merchant account uses before going live. Payment links are not offered by
 * this API (createPaymentLink throws). The callback carries no event id or
 * timestamp, so the event id is derived from transaction id + code.
 */
import { getEnv } from "@/lib/env";
import { methodKind, readJson, safeEqual, sha256Hex } from "./common";
import {
  GatewayNotConfiguredError,
  type CreateGatewayOrderInput,
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

interface PhonePeResponse<T> {
  success: boolean;
  code: string;
  message?: string;
  data?: T;
}

function host(): string {
  return getEnv().PHONEPE_ENV === "production" ? "https://api.phonepe.com/apis/hermes" : "https://api-preprod.phonepe.com/apis/pg-sandbox";
}

function statusOf(code: string, state?: string): GatewayOrderStatus {
  if (code === "PAYMENT_SUCCESS" || state === "COMPLETED") return "CAPTURED";
  if (code === "PAYMENT_PENDING" || state === "PENDING") return "PENDING";
  if (code === "PAYMENT_ERROR" || code === "PAYMENT_DECLINED" || code === "TIMED_OUT" || state === "FAILED") return "FAILED";
  return "PENDING";
}

function refundStatusOf(code: string, state?: string): GatewayRefundStatus {
  if (code === "PAYMENT_SUCCESS" || state === "COMPLETED") return "SUCCESS";
  if (state === "FAILED" || code === "PAYMENT_ERROR") return "FAILED";
  return "PENDING";
}

export class PhonePeGateway implements PaymentGateway {
  readonly name = "PHONEPE" as const;

  isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.PHONEPE_MERCHANT_ID && env.PHONEPE_SALT_KEY && env.PHONEPE_SALT_INDEX);
  }

  private keys(): { merchantId: string; saltKey: string; saltIndex: string } {
    if (!this.isConfigured()) throw new GatewayNotConfiguredError(this.name);
    const env = getEnv();
    return { merchantId: env.PHONEPE_MERCHANT_ID!, saltKey: env.PHONEPE_SALT_KEY!, saltIndex: env.PHONEPE_SALT_INDEX! };
  }

  /** X-VERIFY for a request: sha256(payload + path + saltKey) ### saltIndex. */
  checksum(payload: string, path: string): string {
    const { saltKey, saltIndex } = this.keys();
    return `${sha256Hex(payload + path + saltKey)}###${saltIndex}`;
  }

  private async post<T>(path: string, body: Record<string, unknown>, label: string): Promise<PhonePeResponse<T>> {
    const encoded = Buffer.from(JSON.stringify(body)).toString("base64");
    const response = await fetch(`${host()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VERIFY": this.checksum(encoded, path) },
      body: JSON.stringify({ request: encoded }),
    });
    return readJson<PhonePeResponse<T>>(response, `phonepe ${label}`);
  }

  private async get<T>(path: string, label: string): Promise<PhonePeResponse<T>> {
    const { merchantId } = this.keys();
    const response = await fetch(`${host()}${path}`, {
      method: "GET",
      headers: { "Content-Type": "application/json", "X-VERIFY": this.checksum("", path), "X-MERCHANT-ID": merchantId },
    });
    return readJson<PhonePeResponse<T>>(response, `phonepe ${label}`);
  }

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    const { merchantId } = this.keys();
    const res = await this.post<{ instrumentResponse?: { redirectInfo?: { url?: string } } }>(
      "/pg/v1/pay",
      {
        merchantId,
        merchantTransactionId: input.merchantOrderId,
        merchantUserId: input.customer.id.replace(/-/g, "").slice(0, 36),
        amount: input.amountPaise,
        redirectUrl: input.returnUrl,
        redirectMode: "REDIRECT",
        callbackUrl: input.notifyUrl,
        ...(input.customer.phone ? { mobileNumber: input.customer.phone.replace(/^\+91/, "") } : {}),
        paymentInstrument: { type: "PAY_PAGE" },
      },
      "pay",
    );
    const url = res.data?.instrumentResponse?.redirectInfo?.url;
    if (!res.success || !url) throw new Error(`PhonePe did not start the payment (${res.code}).`);
    return { gatewayOrderId: input.merchantOrderId, status: "PENDING", checkout: { kind: "HOSTED_URL", url }, expiresAt: input.expiresAt ?? null };
  }

  async fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState> {
    const { merchantId } = this.keys();
    const res = await this.get<{ amount?: number; state?: string; transactionId?: string; paymentInstrument?: { type?: string } }>(
      `/pg/v1/status/${merchantId}/${encodeURIComponent(gatewayOrderId)}`,
      "status",
    );
    const status = statusOf(res.code, res.data?.state);
    return {
      gatewayOrderId,
      status,
      amountPaise: res.data?.amount ?? 0,
      gatewayPaymentId: status === "CAPTURED" ? (res.data?.transactionId ?? null) : null,
      method: methodKind(res.data?.paymentInstrument?.type),
      failureReason: status === "FAILED" ? (res.message ?? res.code) : null,
    };
  }

  async createPaymentLink(): Promise<GatewayPaymentLink> {
    throw new Error("PhonePe Standard Checkout has no payment links; use another gateway for link payments.");
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    const { merchantId } = this.keys();
    const res = await this.post<{ transactionId?: string; state?: string }>(
      "/pg/v1/refund",
      {
        merchantId,
        merchantUserId: "gokesari",
        originalTransactionId: input.gatewayOrderId,
        merchantTransactionId: input.merchantRefundId,
        amount: input.amountPaise,
        callbackUrl: "",
      },
      "refund",
    );
    return { gatewayRefundId: res.data?.transactionId ?? input.merchantRefundId, status: refundStatusOf(res.code, res.data?.state) };
  }

  async fetchRefund(_gatewayOrderId: string, merchantRefundId: string): Promise<GatewayRefund> {
    const { merchantId } = this.keys();
    const res = await this.get<{ transactionId?: string; state?: string }>(
      `/pg/v1/status/${merchantId}/${encodeURIComponent(merchantRefundId)}`,
      "refund status",
    );
    return { gatewayRefundId: res.data?.transactionId ?? merchantRefundId, status: refundStatusOf(res.code, res.data?.state) };
  }

  verifyWebhook(rawBody: string, headers: Headers): boolean {
    if (!this.isConfigured()) return false;
    const signature = headers.get("x-verify");
    if (!signature) return false;
    let response: string | undefined;
    try {
      response = (JSON.parse(rawBody) as { response?: string }).response;
    } catch {
      return false;
    }
    if (!response) return false;
    const { saltKey, saltIndex } = this.keys();
    return safeEqual(`${sha256Hex(response + saltKey)}###${saltIndex}`, signature);
  }

  parseWebhook(rawBody: string): GatewayWebhookEvent {
    const outer = JSON.parse(rawBody) as { response: string };
    const inner = JSON.parse(Buffer.from(outer.response, "base64").toString("utf8")) as PhonePeResponse<{
      merchantTransactionId?: string;
      transactionId?: string;
      amount?: number;
      state?: string;
    }>;
    const status = statusOf(inner.code, inner.data?.state);
    const kind: GatewayWebhookKind = status === "CAPTURED" ? "PAYMENT_CAPTURED" : status === "FAILED" ? "PAYMENT_FAILED" : "UNKNOWN";
    const ref = inner.data?.merchantTransactionId ?? null;
    return {
      eventId: `${ref ?? "?"}:${inner.code}:${inner.data?.state ?? ""}`,
      kind,
      merchantRef: ref,
      gatewayOrderId: ref,
      gatewayPaymentId: inner.data?.transactionId ?? null,
      gatewayRefundId: null,
      amountPaise: inner.data?.amount ?? null,
      occurredAt: new Date(),
      raw: inner,
    };
  }
}
