/**
 * Payment intents — one gateway payment for one purpose (an order, an order
 * group, a shop's registration fee, ...), with the state machine
 *
 *   CREATED → PENDING → AUTHORIZED → CAPTURED → PARTIALLY_REFUNDED → REFUNDED
 *          ↘ FAILED / EXPIRED
 *
 * batch-2026-10 contract, implemented by workstream A (payments). Other
 * workstreams import these signatures. Guarantees:
 *
 *  - Idempotent creation: `idempotencyKey` is UNIQUE, so the same key always
 *    returns the same intent (a double click never opens a second payment),
 *    and the gateway order is created at most once per intent (row-locked;
 *    the gateway is also idempotent on our merchant order id).
 *  - Status only moves through the state machine (intent-store.ts), recorded
 *    in payment_intent_events and emitted as payment.* events.
 *  - Status is moved only on the gateway's own answer (fetchOrder / fetchRefund),
 *    never on what a browser or a webhook body claims (processing.ts).
 *  - Refunds are idempotent per key (merchant refund id derived from it), can
 *    never exceed what was captured, and move the intent to
 *    PARTIALLY_REFUNDED / REFUNDED only when the gateway reports SUCCESS.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { AppError, conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import {
  LIVE_PAYMENT_INTENT_STATUSES,
  PAID_PAYMENT_INTENT_STATUSES,
  type PaymentIntentStatusValue,
} from "@/lib/payment-intent-states";
import { db, transactionOnce, type DbClient } from "@/server/db";
import {
  orderRefunds,
  orderStatusHistory,
  orders,
  paymentIntentEvents,
  paymentIntents,
  paymentRefunds,
  type PaymentIntentRow,
  type PaymentRefundRow,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { paymentBaseUrl, sha256Hex, webhookUrlFor } from "./gateway/common";
import { assertGatewayUsable, getGatewayByName, getPaymentGateway } from "./gateway/registry";
import { GatewayNotConfiguredError, type GatewayCheckout, type GatewayCustomer, type GatewayName } from "./gateway/types";
import { actionUrlFor, flagPaymentForSupport, lockIntent, merchantOrderIdFor, toIntentRef, transitionIntent } from "./intent-store";

export { PAYMENT_INTENT_STATUSES } from "@/lib/payment-intent-states";
export type PaymentIntentStatus = PaymentIntentStatusValue;

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
  /** batch-2026-10 WS-A (optional): the order this refund is for, when the intent paid an order group. */
  orderId?: string | null;
}

export interface PaymentRefundRef {
  id: string;
  intentId: string;
  amountPaise: number;
  status: "PENDING" | "SUCCESS" | "FAILED";
}

/* ------------------------------------------------------------- helpers */

function toRefundRef(row: PaymentRefundRow): PaymentRefundRef {
  return { id: row.id, intentId: row.intentId, amountPaise: row.amountPaise, status: row.status };
}

/** Our refund id at the gateway: derived from the caller's key, so a retried request reuses it. */
export function merchantRefundIdFor(idempotencyKey: string): string {
  return `gkrf_${sha256Hex(idempotencyKey).slice(0, 32)}`;
}

/** The checkout the customer opens for an intent (hosted page, or our page that opens a gateway SDK). */
export function checkoutOf(row: PaymentIntentRow): GatewayCheckout | null {
  if (row.checkoutKind === "HOSTED_URL" && row.checkoutUrl) return { kind: "HOSTED_URL", url: row.checkoutUrl };
  if (row.checkoutKind === "SDK_SESSION" && row.checkoutToken) {
    return { kind: "SDK_SESSION", sessionToken: row.checkoutToken, url: `/orders/pay/session/${row.id}` };
  }
  return null;
}

/** Where to send the customer's browser to pay. */
export function redirectUrlOf(row: PaymentIntentRow): string | null {
  const checkout = checkoutOf(row);
  if (!checkout) return row.linkUrl;
  return checkout.kind === "HOSTED_URL" ? checkout.url : (checkout.url ?? null);
}

function created(row: PaymentIntentRow): CreatedPaymentIntent {
  return { intent: toIntentRef(row), checkout: row.mode === "CHECKOUT" ? checkoutOf(row) : null, linkUrl: row.linkUrl };
}

async function inTransaction<T>(client: DbClient | undefined, run: (tx: DbClient) => Promise<T>): Promise<T> {
  // A caller's transaction gets a savepoint, so a failure here does not poison theirs.
  return (client ?? db).transaction(run);
}

/* -------------------------------------------------------------- create */

export async function createPaymentIntent(input: CreatePaymentIntentInput, client?: DbClient): Promise<CreatedPaymentIntent> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw validationFailed("The amount to pay must be a positive whole number of paise.");
  const key = input.idempotencyKey?.trim();
  if (!key) throw validationFailed("A payment idempotency key is required.");
  const c = client ?? db;

  const existing = await c.query.paymentIntents.findFirst({ where: eq(paymentIntents.idempotencyKey, key) });
  let row = existing;
  if (!row) {
    const gateway = getPaymentGateway();
    try {
      await assertGatewayUsable(gateway);
    } catch (error) {
      if (error instanceof GatewayNotConfiguredError) throw conflict("Online payment is not available right now. Please choose another way to pay.");
      throw error;
    }
    const rules = await getRule("onlinePayments");
    const id = randomUUID();
    const [inserted] = await c
      .insert(paymentIntents)
      .values({
        id,
        purpose: input.purpose,
        referenceId: input.referenceId,
        userId: input.userId,
        amountPaise: input.amountPaise,
        gateway: gateway.name,
        mode: input.mode,
        merchantOrderId: merchantOrderIdFor(id),
        idempotencyKey: key,
        description: input.description.slice(0, 200),
        returnPath: input.returnPath ?? null,
        expiresAt: new Date(Date.now() + rules.intentExpiryMinutes * 60_000),
        metadata: {
          customer: { id: input.customer.id, name: input.customer.name ?? null, email: input.customer.email ?? null, phone: input.customer.phone ?? null },
        },
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      row = inserted;
      await c.insert(paymentIntentEvents).values({
        intentId: inserted.id,
        fromStatus: null,
        toStatus: "CREATED",
        source: "API",
      });
      await recordAudit(
        {
          actorId: input.userId,
          action: AUDIT_ACTIONS.PAYMENT_INTENT_CREATED,
          entityType: "payment_intent",
          entityId: inserted.id,
          newValue: { purpose: input.purpose, referenceId: input.referenceId, amountPaise: input.amountPaise, gateway: gateway.name },
        },
        c,
      );
    } else {
      row = await c.query.paymentIntents.findFirst({ where: eq(paymentIntents.idempotencyKey, key) });
    }
  }
  if (!row) throw new AppError("INTERNAL", "Could not start the payment.");
  if (row.purpose !== input.purpose || row.referenceId !== input.referenceId || row.amountPaise !== input.amountPaise) {
    throw conflict("This payment key was already used for a different payment.");
  }
  if (row.status !== "CREATED" || row.gatewayOrderId) return created(row);
  return created(await openAtGateway(row.id, client));
}

/**
 * Creates the gateway order (or link) for a CREATED intent, once: the row is
 * locked, so a double click waits and then finds it done. On its own (no
 * caller's transaction) it is never re-run: a re-run would send the same
 * merchant order id to the gateway again, which refuses it, and leave the
 * intent stuck until it expires (seller / customer split, transactionOnce).
 */
async function openAtGateway(intentId: string, client: DbClient | undefined): Promise<PaymentIntentRow> {
  const open = (run: (tx: DbClient) => Promise<PaymentIntentRow>) => (client ? client.transaction(run) : transactionOnce(run));
  return open(async (tx) => {
    const row = await lockIntent(tx, intentId);
    if (!row) throw notFound("Payment");
    if (row.status !== "CREATED" || row.gatewayOrderId) return row;
    const gateway = getGatewayByName(row.gateway);
    await assertGatewayUsable(gateway);
    const rules = await getRule("onlinePayments");
    const meta = (row.metadata ?? {}) as { customer?: GatewayCustomer };
    const customer: GatewayCustomer = meta.customer ?? { id: row.userId ?? row.referenceId };
    const returnUrl = `${paymentBaseUrl()}${actionUrlFor(row)}`;
    const notifyUrl = webhookUrlFor(row.gateway);
    try {
      if (row.mode === "LINK") {
        const link = await gateway.createPaymentLink({
          merchantLinkId: row.merchantOrderId,
          amountPaise: row.amountPaise,
          customer,
          description: row.description,
          expiresAt: row.expiresAt ?? new Date(Date.now() + rules.intentExpiryMinutes * 60_000),
          notifyUrl,
          returnUrl,
        });
        return transitionIntent(tx, row, "PENDING", {
          source: "API",
          note: "Payment link created",
          patch: { gatewayOrderId: link.gatewayLinkId, linkUrl: link.url, expiresAt: link.expiresAt },
        });
      }
      const order = await gateway.createOrder({
        merchantOrderId: row.merchantOrderId,
        amountPaise: row.amountPaise,
        customer,
        returnUrl,
        notifyUrl,
        methods: rules.methods,
        expiresAt: row.expiresAt ?? undefined,
        description: row.description,
        metadata: { intentId: row.id, purpose: row.purpose },
      });
      return transitionIntent(tx, row, "PENDING", {
        source: "API",
        note: "Gateway order created",
        patch: {
          gatewayOrderId: order.gatewayOrderId,
          checkoutKind: order.checkout.kind,
          checkoutUrl: order.checkout.kind === "HOSTED_URL" ? order.checkout.url : (order.checkout.url ?? null),
          checkoutToken: order.checkout.kind === "SDK_SESSION" ? order.checkout.sessionToken : null,
          expiresAt: order.expiresAt ?? row.expiresAt,
        },
      });
    } catch (error) {
      // The intent stays CREATED: the same key retries, and the reconciliation job expires it if nobody does.
      console.error("[payments] gateway order creation failed", row.id, error);
      if (error instanceof AppError) throw error;
      throw conflict("We could not start the payment just now. Please try again in a minute.");
    }
  });
}

/* ---------------------------------------------------------------- read */

export async function getPaymentIntent(id: string, client?: DbClient): Promise<PaymentIntentRef | null> {
  const row = await (client ?? db).query.paymentIntents.findFirst({ where: eq(paymentIntents.id, id) });
  return row ? toIntentRef(row) : null;
}

export async function getPaymentIntentRow(id: string, client?: DbClient): Promise<PaymentIntentRow | null> {
  return (await (client ?? db).query.paymentIntents.findFirst({ where: eq(paymentIntents.id, id) })) ?? null;
}

/** The latest CAPTURED (or partly refunded) intent for a purpose + reference, if any. */
export async function findCapturedIntent(
  purpose: PaymentPurpose,
  referenceId: string,
  client?: DbClient,
): Promise<PaymentIntentRef | null> {
  const row = await (client ?? db).query.paymentIntents.findFirst({
    where: and(
      eq(paymentIntents.purpose, purpose),
      eq(paymentIntents.referenceId, referenceId),
      inArray(paymentIntents.status, ["CAPTURED", "PARTIALLY_REFUNDED"]),
    ),
    orderBy: desc(paymentIntents.createdAt),
  });
  return row ? toIntentRef(row) : null;
}

/** Every intent for a purpose + reference, newest first. */
export async function listIntentsFor(purpose: PaymentPurpose, referenceId: string, client?: DbClient): Promise<PaymentIntentRow[]> {
  return (client ?? db)
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.purpose, purpose), eq(paymentIntents.referenceId, referenceId)))
    .orderBy(desc(paymentIntents.createdAt));
}

export function isLive(row: Pick<PaymentIntentRow, "status">): boolean {
  return LIVE_PAYMENT_INTENT_STATUSES.includes(row.status);
}

export function isPaid(row: Pick<PaymentIntentRow, "status">): boolean {
  return PAID_PAYMENT_INTENT_STATUSES.includes(row.status);
}

/* -------------------------------------------------------------- refund */

/**
 * Refund to the original method through the gateway; moves the intent to
 * PARTIALLY_REFUNDED / REFUNDED when the gateway confirms it.
 *
 * Called without `client`: the refund is sent to the gateway now. Called with
 * the caller's transaction: the refund is recorded (PENDING) in it and sent by
 * the reconciliation job after that transaction has committed — an external
 * refund must never happen for a change that might still roll back.
 */
export async function refundPaymentIntent(input: RefundPaymentIntentInput, client?: DbClient): Promise<PaymentRefundRef> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) throw validationFailed("The refund must be a positive whole number of paise.");
  const key = input.idempotencyKey?.trim();
  if (!key) throw validationFailed("A refund idempotency key is required.");

  const refund = await inTransaction(client, async (tx) => {
    const intent = await lockIntent(tx, input.intentId);
    if (!intent) throw notFound("Payment");
    const [existing] = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.idempotencyKey, key));
    if (existing) {
      if (existing.intentId !== intent.id) throw conflict("This refund key was already used for another payment.");
      return existing;
    }
    if (intent.status !== "CAPTURED" && intent.status !== "PARTIALLY_REFUNDED") {
      throw conflict("Only a received payment can be refunded.");
    }
    const live = await tx
      .select({ amountPaise: paymentRefunds.amountPaise })
      .from(paymentRefunds)
      .where(and(eq(paymentRefunds.intentId, intent.id), inArray(paymentRefunds.status, ["PENDING", "SUCCESS"])));
    const committed = live.reduce((n, r) => n + r.amountPaise, 0);
    if (committed + input.amountPaise > intent.amountPaise) {
      throw validationFailed(
        `Only ${formatPaise(Math.max(0, intent.amountPaise - committed))} of this payment can still be refunded.`,
      );
    }
    const [row] = await tx
      .insert(paymentRefunds)
      .values({
        intentId: intent.id,
        merchantRefundId: merchantRefundIdFor(key),
        idempotencyKey: key,
        amountPaise: input.amountPaise,
        reason: input.reason.slice(0, 500) || "Refund",
        orderId: input.orderId ?? null,
      })
      .returning();
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_REFUND_REQUESTED,
        entityType: "payment_intent",
        entityId: intent.id,
        newValue: { refundId: row.id, amountPaise: input.amountPaise, reason: input.reason, deferred: Boolean(client) },
      },
      tx,
    );
    return row;
  });

  if (client || refund.status !== "PENDING" || refund.submittedAt) return toRefundRef(refund);
  return toRefundRef(await submitRefund(refund.id));
}

/**
 * Sends a recorded refund to the gateway (idempotent there on the merchant
 * refund id) and settles it if the gateway answers at once.
 */
export async function submitRefund(refundId: string): Promise<PaymentRefundRow> {
  const [refund] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, refundId));
  if (!refund) throw notFound("Refund");
  if (refund.status !== "PENDING") return refund;
  const intent = await getPaymentIntentRow(refund.intentId);
  if (!intent || !intent.gatewayOrderId) throw notFound("Payment");
  const gateway = getGatewayByName(intent.gateway);
  try {
    const result = await gateway.refund({
      gatewayOrderId: intent.gatewayOrderId,
      gatewayPaymentId: intent.gatewayPaymentId,
      merchantRefundId: refund.merchantRefundId,
      amountPaise: refund.amountPaise,
      reason: refund.reason,
    });
    const [submitted] = await db
      .update(paymentRefunds)
      .set({ submittedAt: new Date(), gatewayRefundId: result.gatewayRefundId, updatedAt: new Date() })
      .where(eq(paymentRefunds.id, refund.id))
      .returning();
    if (result.status === "PENDING") return submitted;
    return settleRefund(refund.id, result.status, { gatewayRefundId: result.gatewayRefundId, source: "REFUND" });
  } catch (error) {
    // Left PENDING and unsubmitted: the reconciliation job sends it again (same merchant refund id).
    console.error("[payments] refund submission failed", refund.id, error);
    return refund;
  }
}

/**
 * Applies the gateway's final answer for a refund. SUCCESS adds to the
 * intent's refunded amount and moves it to PARTIALLY_REFUNDED / REFUNDED
 * (event payment.refunded → the customer is told); FAILED alerts support.
 * Idempotent: a refund already settled is left alone.
 */
export async function settleRefund(
  refundId: string,
  status: "SUCCESS" | "FAILED",
  options: { gatewayRefundId?: string | null; failureReason?: string | null; source: "WEBHOOK" | "RECONCILE" | "REFUND"; webhookEventId?: string | null },
): Promise<PaymentRefundRow> {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ intentId: paymentRefunds.intentId }).from(paymentRefunds).where(eq(paymentRefunds.id, refundId));
    if (!peek) throw notFound("Refund");
    // Lock order: intent, then refund (the same order refundPaymentIntent uses).
    const intent = await lockIntent(tx, peek.intentId);
    const [refund] = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.id, refundId)).for("update");
    if (!intent || !refund) throw notFound("Refund");
    if (refund.status !== "PENDING") return refund;

    const [settled] = await tx
      .update(paymentRefunds)
      .set({
        status,
        gatewayRefundId: options.gatewayRefundId ?? refund.gatewayRefundId,
        failureReason: status === "FAILED" ? (options.failureReason ?? "Refused by the gateway") : null,
        settledAt: new Date(),
        submittedAt: refund.submittedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(paymentRefunds.id, refund.id))
      .returning();
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_REFUND_SETTLED,
        entityType: "payment_intent",
        entityId: intent.id,
        newValue: { refundId: refund.id, status, amountPaise: refund.amountPaise, source: options.source },
      },
      tx,
    );

    if (status === "FAILED") {
      await flagPaymentForSupport(tx, intent, `A refund of ${formatPaise(refund.amountPaise)} failed at the gateway. Refund it another way.`, `refund-failed:${refund.id}`);
      return settled;
    }
    const refundedPaise = intent.refundedPaise + refund.amountPaise;
    await transitionIntent(tx, intent, refundedPaise >= intent.amountPaise ? "REFUNDED" : "PARTIALLY_REFUNDED", {
      source: options.source === "REFUND" ? "REFUND" : options.source,
      note: `Refund ${refund.merchantRefundId}: ${formatPaise(refund.amountPaise)}`,
      webhookEventId: options.webhookEventId ?? null,
      patch: { refundedPaise },
      eventAmountPaise: refund.amountPaise,
    });
    // An order waiting for this refund (cancelled after an online payment) is now refunded —
    // once no other refund of it is still on its way (a removed line's refund can be in flight
    // with the cancellation's, TC-PAY-029).
    if (refund.orderId) {
      const [order] = await tx.select().from(orders).where(eq(orders.id, refund.orderId)).for("update");
      if (order?.status === "REFUND_PENDING" && !(await otherRefundInFlight(tx, order.id, refund))) {
        await tx.update(orders).set({ status: "REFUNDED", updatedAt: new Date() }).where(eq(orders.id, order.id));
        await tx.insert(orderStatusHistory).values({
          orderId: order.id,
          previousStatus: "REFUND_PENDING",
          newStatus: "REFUNDED",
          changedBy: null,
          note: `Refunded ${formatPaise(refund.amountPaise)} to the original payment method`,
        });
      }
    }
    return settled;
  });
}

/**
 * Another refund of the order not settled yet: a gateway refund still PENDING,
 * or an aftercare refund (order_refunds) not sent yet. The aftercare row this
 * refund was sent for ("order-refund:<id>") is this refund itself.
 */
async function otherRefundInFlight(tx: DbClient, orderId: string, refund: PaymentRefundRow): Promise<boolean> {
  const [pending] = await tx
    .select({ id: paymentRefunds.id })
    .from(paymentRefunds)
    .where(and(eq(paymentRefunds.orderId, orderId), eq(paymentRefunds.status, "PENDING"), ne(paymentRefunds.id, refund.id)))
    .limit(1);
  if (pending) return true;
  const [requested] = await tx
    .select({ id: orderRefunds.id })
    .from(orderRefunds)
    .where(
      and(
        eq(orderRefunds.orderId, orderId),
        eq(orderRefunds.method, "ORIGINAL"),
        eq(orderRefunds.status, "REQUESTED"),
        sql`'order-refund:' || ${orderRefunds.id}::text <> ${refund.idempotencyKey}`,
      ),
    )
    .limit(1);
  return Boolean(requested);
}

export async function listRefundsFor(intentId: string): Promise<PaymentRefundRow[]> {
  return db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, intentId)).orderBy(desc(paymentRefunds.createdAt));
}
