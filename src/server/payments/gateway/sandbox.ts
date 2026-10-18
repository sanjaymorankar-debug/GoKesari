/**
 * SandboxGateway — a deterministic payment gateway that runs inside this
 * server (batch-2026-10 WS-A). No network: its "gateway side" is the
 * payment_sandbox_orders table, so tests, staging and several app instances
 * all see the same state.
 *
 *  - createOrder        → a sandbox order + a hosted page at /orders/pay/sandbox/<merchantOrderId>
 *  - simulate()         → the customer's result (success / failure / expiry), returned as
 *                         a webhook signed exactly as a real one would be
 *  - refund()           → settles at once by default; `sandboxSettings.refundMode` makes it
 *                         PENDING (settled later by settleRefund()) or FAILED, for tests
 *  - verifyWebhook()    → HMAC-SHA256 hex over `${timestamp}.${rawBody}`, headers
 *                         x-sandbox-timestamp / x-sandbox-signature, 5-minute freshness
 *
 * Refused in production unless PAYMENT_GATEWAY=SANDBOX and rule
 * onlinePayments.allowSandboxInProduction (see registry.ts). Its webhook
 * secret is PAYMENT_WEBHOOK_SECRET_SANDBOX, or a fixed test secret outside
 * production.
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import { derivedTestSecret, getEnv, isProductionSite } from "@/lib/env";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { paymentSandboxOrders, type PaymentSandboxOrder } from "@/server/db/schema";
import { hmacHex, isFresh, safeEqual } from "./common";
import type {
  CreateGatewayOrderInput,
  CreatePaymentLinkInput,
  GatewayOrder,
  GatewayOrderState,
  GatewayPaymentLink,
  GatewayRefund,
  GatewayRefundInput,
  GatewayRefundStatus,
  GatewayWebhookEvent,
  GatewayWebhookKind,
  PaymentGateway,
  PaymentMethodKind,
} from "./types";

/** Used only outside production when PAYMENT_WEBHOOK_SECRET_SANDBOX is not set. */
export const SANDBOX_TEST_WEBHOOK_SECRET = "sandbox_test_webhook_secret";

/** Knobs for tests (module state, never read from a request). */
export const sandboxSettings: { refundMode: GatewayRefundStatus } = { refundMode: "SUCCESS" };

export type SandboxOutcome = "SUCCESS" | "FAILURE" | "EXPIRE" | "PENDING";

export interface SignedWebhook {
  rawBody: string;
  headers: Headers;
}

interface SandboxWebhookBody {
  eventId: string;
  type: GatewayWebhookKind;
  merchantOrderId: string | null;
  gatewayOrderId: string | null;
  paymentId: string | null;
  merchantRefundId?: string | null;
  refundId?: string | null;
  amountPaise: number | null;
  occurredAt: string;
}

function sandboxSecret(): string | null {
  const env = getEnv();
  if (env.PAYMENT_WEBHOOK_SECRET_SANDBOX) return env.PAYMENT_WEBHOOK_SECRET_SANDBOX;
  if (env.NODE_ENV !== "production") return SANDBOX_TEST_WEBHOOK_SECRET;
  // A production build that is not gokesari.com (the test site): a per-deployment secret.
  return isProductionSite(env) ? null : derivedTestSecret("sandbox-payment-webhook", env);
}

/** Signs a sandbox webhook body the way the sandbox "gateway" does. */
export function signSandboxWebhook(rawBody: string, timestamp: string = String(Date.now())): SignedWebhook {
  const secret = sandboxSecret();
  if (!secret) throw new Error("PAYMENT_WEBHOOK_SECRET_SANDBOX is not set.");
  const headers = new Headers({
    "content-type": "application/json",
    "x-sandbox-timestamp": timestamp,
    "x-sandbox-signature": hmacHex(secret, `${timestamp}.${rawBody}`),
  });
  return { rawBody, headers };
}

function toState(row: PaymentSandboxOrder): GatewayOrderState {
  return {
    gatewayOrderId: row.gatewayOrderId,
    status: row.status,
    amountPaise: row.amountPaise,
    gatewayPaymentId: row.paymentId,
    method: (row.method as PaymentMethodKind | null) ?? null,
    failureReason: row.failureReason,
  };
}

async function loadOrder(gatewayOrderId: string): Promise<PaymentSandboxOrder> {
  const [row] = await db.select().from(paymentSandboxOrders).where(eq(paymentSandboxOrders.gatewayOrderId, gatewayOrderId));
  if (!row) throw notFound("Sandbox payment");
  return row;
}

export class SandboxGateway implements PaymentGateway {
  readonly name = "SANDBOX" as const;

  isConfigured(): boolean {
    return true;
  }

  /** The sandbox hosted page for an attempt. */
  static checkoutPath(merchantOrderId: string): string {
    return `/orders/pay/sandbox/${encodeURIComponent(merchantOrderId)}`;
  }

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw validationFailed("Amount must be positive.");
    const gatewayOrderId = `sbx_${input.merchantOrderId}`;
    // Idempotent on the merchant order id, like a real gateway.
    await db
      .insert(paymentSandboxOrders)
      .values({
        gatewayOrderId,
        merchantOrderId: input.merchantOrderId,
        kind: "ORDER",
        amountPaise: input.amountPaise,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoNothing();
    const row = await loadOrder(gatewayOrderId);
    if (row.amountPaise !== input.amountPaise) throw conflict("A sandbox order with this id exists for another amount.");
    return {
      gatewayOrderId,
      status: row.status,
      checkout: { kind: "HOSTED_URL", url: SandboxGateway.checkoutPath(input.merchantOrderId) },
      expiresAt: row.expiresAt,
    };
  }

  async fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState> {
    const row = await loadOrder(gatewayOrderId);
    // Deterministic expiry: an unpaid order past its expiry time is EXPIRED, as a real gateway reports it.
    if ((row.status === "CREATED" || row.status === "PENDING") && row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      const [expired] = await db
        .update(paymentSandboxOrders)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(eq(paymentSandboxOrders.gatewayOrderId, gatewayOrderId))
        .returning();
      return toState(expired);
    }
    return toState(row);
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<GatewayPaymentLink> {
    const gatewayOrderId = `sbx_${input.merchantLinkId}`;
    await db
      .insert(paymentSandboxOrders)
      .values({
        gatewayOrderId,
        merchantOrderId: input.merchantLinkId,
        kind: "LINK",
        amountPaise: input.amountPaise,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing();
    const row = await loadOrder(gatewayOrderId);
    return { gatewayLinkId: gatewayOrderId, url: SandboxGateway.checkoutPath(input.merchantLinkId), expiresAt: row.expiresAt ?? input.expiresAt };
  }

  async refund(input: GatewayRefundInput): Promise<GatewayRefund> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(paymentSandboxOrders)
        .where(eq(paymentSandboxOrders.gatewayOrderId, input.gatewayOrderId))
        .for("update");
      if (!row) throw notFound("Sandbox payment");
      const existing = row.refunds.find((r) => r.merchantRefundId === input.merchantRefundId);
      if (existing) return { gatewayRefundId: existing.gatewayRefundId, status: existing.status };
      if (row.status !== "CAPTURED") throw conflict("Only a captured sandbox payment can be refunded.");
      const already = row.refunds.filter((r) => r.status !== "FAILED").reduce((n, r) => n + r.amountPaise, 0);
      if (input.amountPaise <= 0 || already + input.amountPaise > row.amountPaise) {
        throw validationFailed("The refund is more than what is left of the sandbox payment.");
      }
      const refund = {
        merchantRefundId: input.merchantRefundId,
        gatewayRefundId: `sbxrf_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        amountPaise: input.amountPaise,
        status: sandboxSettings.refundMode,
      };
      await tx
        .update(paymentSandboxOrders)
        .set({ refunds: [...row.refunds, refund], updatedAt: new Date() })
        .where(eq(paymentSandboxOrders.gatewayOrderId, row.gatewayOrderId));
      return { gatewayRefundId: refund.gatewayRefundId, status: refund.status };
    });
  }

  async fetchRefund(gatewayOrderId: string, merchantRefundId: string): Promise<GatewayRefund> {
    const row = await loadOrder(gatewayOrderId);
    const refund = row.refunds.find((r) => r.merchantRefundId === merchantRefundId);
    if (!refund) throw notFound("Sandbox refund");
    return { gatewayRefundId: refund.gatewayRefundId, status: refund.status };
  }

  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = sandboxSecret();
    const timestamp = headers.get("x-sandbox-timestamp");
    const signature = headers.get("x-sandbox-signature");
    if (!secret || !signature || !isFresh(timestamp)) return false;
    return safeEqual(hmacHex(secret, `${timestamp}.${rawBody}`), signature);
  }

  parseWebhook(rawBody: string): GatewayWebhookEvent {
    const body = JSON.parse(rawBody) as SandboxWebhookBody;
    return {
      eventId: String(body.eventId),
      kind: body.type ?? "UNKNOWN",
      merchantRef: body.merchantRefundId ?? body.merchantOrderId ?? null,
      gatewayOrderId: body.gatewayOrderId ?? null,
      gatewayPaymentId: body.paymentId ?? null,
      gatewayRefundId: body.refundId ?? null,
      amountPaise: body.amountPaise ?? null,
      occurredAt: new Date(body.occurredAt ?? Date.now()),
      raw: body,
    };
  }

  /* ----------------------------------------------- sandbox-only controls */

  /**
   * What the customer did on the sandbox page. Moves the sandbox order and
   * returns the signed webhook the gateway would send (the caller posts it to
   * our webhook route).
   */
  async simulate(gatewayOrderId: string, outcome: SandboxOutcome, method: PaymentMethodKind = "UPI"): Promise<SignedWebhook> {
    const row = await loadOrder(gatewayOrderId);
    const terminal = row.status === "CAPTURED" || row.status === "FAILED" || row.status === "EXPIRED";
    let next = row;
    if (!terminal) {
      const patch: Partial<typeof paymentSandboxOrders.$inferInsert> = { updatedAt: new Date(), method };
      if (outcome === "SUCCESS") {
        patch.status = "CAPTURED";
        patch.paymentId = `sbxpay_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      } else if (outcome === "FAILURE") {
        patch.status = "FAILED";
        patch.failureReason = "Declined in the sandbox";
      } else if (outcome === "EXPIRE") {
        patch.status = "EXPIRED";
      } else {
        patch.status = "PENDING";
      }
      [next] = await db
        .update(paymentSandboxOrders)
        .set(patch)
        .where(eq(paymentSandboxOrders.gatewayOrderId, gatewayOrderId))
        .returning();
    }
    const type: GatewayWebhookKind =
      next.status === "CAPTURED"
        ? next.kind === "LINK"
          ? "LINK_PAID"
          : "PAYMENT_CAPTURED"
        : next.status === "FAILED"
          ? "PAYMENT_FAILED"
          : next.status === "EXPIRED"
            ? "ORDER_EXPIRED"
            : "PAYMENT_AUTHORIZED";
    return this.webhookFor({
      type,
      merchantOrderId: next.merchantOrderId,
      gatewayOrderId: next.gatewayOrderId,
      paymentId: next.paymentId,
      amountPaise: next.amountPaise,
    });
  }

  /** Settles a PENDING sandbox refund and returns the gateway's refund webhook. */
  async settleRefund(gatewayOrderId: string, merchantRefundId: string, status: "SUCCESS" | "FAILED"): Promise<SignedWebhook> {
    const row = await loadOrder(gatewayOrderId);
    const refunds = row.refunds.map((r) => (r.merchantRefundId === merchantRefundId && r.status === "PENDING" ? { ...r, status } : r));
    await db
      .update(paymentSandboxOrders)
      .set({ refunds, updatedAt: sql`now()` })
      .where(eq(paymentSandboxOrders.gatewayOrderId, gatewayOrderId));
    const refund = refunds.find((r) => r.merchantRefundId === merchantRefundId);
    return this.webhookFor({
      type: refund?.status === "SUCCESS" ? "REFUND_SUCCESS" : "REFUND_FAILED",
      merchantOrderId: row.merchantOrderId,
      gatewayOrderId,
      paymentId: row.paymentId,
      merchantRefundId,
      refundId: refund?.gatewayRefundId ?? null,
      amountPaise: refund?.amountPaise ?? null,
    });
  }

  webhookFor(body: Omit<SandboxWebhookBody, "eventId" | "occurredAt"> & { eventId?: string }): SignedWebhook {
    const full: SandboxWebhookBody = {
      ...body,
      eventId: body.eventId ?? `sbxevt_${randomUUID()}`,
      occurredAt: new Date().toISOString(),
    };
    return signSandboxWebhook(JSON.stringify(full));
  }
}
