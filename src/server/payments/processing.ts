/**
 * Moving payment intents on the gateway's word (batch-2026-10 WS-A):
 * webhooks, the reconciliation job and the return page all end here.
 *
 *  1. Webhook: signature verified over the raw body (bad → 401, recorded);
 *     the delivery is stored in payment_webhook_events with
 *     ON CONFLICT (gateway, event_id) DO NOTHING — a repeat of a processed
 *     event is acknowledged and ignored.
 *  2. The webhook is only a trigger: the intent's state is taken from the
 *     gateway's own fetchOrder / fetchRefund, never from the webhook body.
 *  3. The move runs in one transaction with SELECT … FOR UPDATE on the
 *     intent, through the state machine; CAPTURED runs
 *     CAPTURED_HANDLERS[purpose] and FAILED / EXPIRED run
 *     PAYMENT_ENDED_HANDLERS[purpose] in that same transaction.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { LIVE_PAYMENT_INTENT_STATUSES } from "@/lib/payment-intent-states";
import { canMove } from "@/lib/state-machines";
import { db, type DbClient } from "@/server/db";
import {
  orders,
  paymentIntents,
  paymentRefunds,
  paymentWebhookEvents,
  type PaymentIntentRow,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { PAYMENT_ENDED_HANDLERS } from "./ended-handlers";
import { getGatewayByName, parseGatewayName, sandboxAllowed } from "./gateway/registry";
import type { GatewayOrderState, GatewayWebhookEvent, PaymentGateway } from "./gateway/types";
import { flagPaymentForSupport, lockIntent, toIntentRef, transitionIntent, type IntentSource } from "./intent-store";
import { getPaymentIntentRow, settleRefund, submitRefund } from "./intents";
import { CAPTURED_HANDLERS } from "./purpose-handlers";

export type ApplyOutcome = "MOVED" | "NO_CHANGE" | "AMOUNT_MISMATCH" | "LATE_CAPTURE" | "NOT_FOUND";

export interface ApplyResult {
  outcome: ApplyOutcome;
  status: PaymentIntentRow["status"] | null;
}

/** Ends a locked intent (FAILED / EXPIRED) and runs its purpose's ended handler. */
async function endIntent(
  tx: DbClient,
  row: PaymentIntentRow,
  to: "FAILED" | "EXPIRED",
  source: IntentSource,
  reason: string | null,
  webhookEventId: string | null,
): Promise<PaymentIntentRow> {
  const ended = await transitionIntent(tx, row, to, {
    source,
    note: reason,
    reason,
    webhookEventId,
    patch: { failureReason: reason, endedAt: new Date() },
  });
  await PAYMENT_ENDED_HANDLERS[row.purpose]?.(ended, to, tx);
  return ended;
}

/**
 * Applies the gateway's state of an attempt to our intent. Idempotent: the
 * same state twice is NO_CHANGE.
 */
export async function applyGatewayState(
  intentId: string,
  state: GatewayOrderState,
  context: { source: IntentSource; webhookEventId?: string | null },
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    const row = await lockIntent(tx, intentId);
    if (!row) return { outcome: "NOT_FOUND" as const, status: null };
    const touch = {
      lastReconciledAt: new Date(),
      ...(context.source === "RECONCILE" ? { reconcileAttempts: sql`${paymentIntents.reconcileAttempts} + 1` } : {}),
    };
    await tx.update(paymentIntents).set(touch).where(eq(paymentIntents.id, row.id));
    const webhookEventId = context.webhookEventId ?? null;

    if (state.status === row.status || state.status === "CREATED") return { outcome: "NO_CHANGE" as const, status: row.status };

    if (state.status === "CAPTURED") {
      if (row.status === "FAILED" || row.status === "EXPIRED") {
        // Money taken after we had given up on the attempt (and released the order).
        await flagPaymentForSupport(
          tx,
          row,
          `The gateway took ${state.amountPaise / 100} rupees (payment ${state.gatewayPaymentId ?? "?"}) after this attempt had ${row.status === "FAILED" ? "failed" : "expired"}. Refund it, or confirm the order by hand.`,
          "late-capture",
        );
        return { outcome: "LATE_CAPTURE" as const, status: row.status };
      }
      if (!canMove("payment_intent", row.status, "CAPTURED")) return { outcome: "NO_CHANGE" as const, status: row.status };
      if (state.amountPaise !== row.amountPaise) {
        await flagPaymentForSupport(
          tx,
          row,
          `The gateway reports ${state.amountPaise} paise captured against ${row.amountPaise} expected. The order was not confirmed.`,
          `amount-mismatch:${state.amountPaise}`,
        );
        return { outcome: "AMOUNT_MISMATCH" as const, status: row.status };
      }
      const captured = await transitionIntent(tx, row, "CAPTURED", {
        source: context.source,
        note: `Payment ${state.gatewayPaymentId ?? ""} captured`.trim(),
        webhookEventId,
        patch: { gatewayPaymentId: state.gatewayPaymentId, method: state.method, capturedAt: new Date(), endedAt: new Date() },
      });
      await CAPTURED_HANDLERS[row.purpose]?.(toIntentRef(captured), tx);
      return { outcome: "MOVED" as const, status: captured.status };
    }

    if (state.status === "FAILED" || state.status === "EXPIRED") {
      if (!canMove("payment_intent", row.status, state.status)) return { outcome: "NO_CHANGE" as const, status: row.status };
      const ended = await endIntent(tx, row, state.status, context.source, state.failureReason ?? null, webhookEventId);
      return { outcome: "MOVED" as const, status: ended.status };
    }

    // PENDING / AUTHORIZED
    if (!canMove("payment_intent", row.status, state.status)) return { outcome: "NO_CHANGE" as const, status: row.status };
    const moved = await transitionIntent(tx, row, state.status, {
      source: context.source,
      webhookEventId,
      patch: state.gatewayPaymentId ? { gatewayPaymentId: state.gatewayPaymentId } : {},
    });
    return { outcome: "MOVED" as const, status: moved.status };
  });
}

/**
 * Asks the gateway about one intent and applies the answer. An intent that
 * never reached the gateway is expired once it is past its time.
 */
export async function reconcileIntent(intentId: string, source: IntentSource = "RECONCILE"): Promise<ApplyResult> {
  const row = await getPaymentIntentRow(intentId);
  if (!row) return { outcome: "NOT_FOUND", status: null };
  if (!LIVE_PAYMENT_INTENT_STATUSES.includes(row.status) && row.status !== "CAPTURED" && row.status !== "FAILED" && row.status !== "EXPIRED") {
    return { outcome: "NO_CHANGE", status: row.status };
  }
  if (!row.gatewayOrderId) {
    if (row.expiresAt && row.expiresAt.getTime() > Date.now()) return { outcome: "NO_CHANGE", status: row.status };
    return db.transaction(async (tx) => {
      const locked = await lockIntent(tx, intentId);
      if (!locked || locked.status !== "CREATED" || locked.gatewayOrderId) return { outcome: "NO_CHANGE" as const, status: locked?.status ?? null };
      const ended = await endIntent(tx, locked, "EXPIRED", source, "The payment page could not be opened in time", null);
      return { outcome: "MOVED" as const, status: ended.status };
    });
  }
  const gateway = getGatewayByName(row.gateway);
  const state = await gateway.fetchOrder(row.gatewayOrderId);
  return applyGatewayState(row.id, state, { source });
}

/* ------------------------------------------------------------- webhook */

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

function payloadFor(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return { unparsable: rawBody.slice(0, 2000) };
  }
}

async function findIntentForEvent(gateway: PaymentGateway, event: GatewayWebhookEvent): Promise<PaymentIntentRow | undefined> {
  const conditions = [];
  if (event.merchantRef) conditions.push(eq(paymentIntents.merchantOrderId, event.merchantRef));
  if (event.gatewayOrderId) conditions.push(and(eq(paymentIntents.gateway, gateway.name), eq(paymentIntents.gatewayOrderId, event.gatewayOrderId)));
  if (conditions.length === 0) return undefined;
  const [row] = await db.select().from(paymentIntents).where(or(...conditions)).limit(1);
  return row;
}

async function processEvent(gateway: PaymentGateway, event: GatewayWebhookEvent, webhookEventId: string): Promise<{ outcome: string; intentId: string | null }> {
  if (event.kind === "REFUND_SUCCESS" || event.kind === "REFUND_FAILED") {
    const conditions = [];
    if (event.merchantRef) conditions.push(eq(paymentRefunds.merchantRefundId, event.merchantRef));
    if (event.gatewayRefundId) conditions.push(eq(paymentRefunds.gatewayRefundId, event.gatewayRefundId));
    const [refund] = conditions.length ? await db.select().from(paymentRefunds).where(or(...conditions)).limit(1) : [];
    if (!refund) return { outcome: "UNKNOWN_REFUND", intentId: null };
    const intent = await getPaymentIntentRow(refund.intentId);
    if (!intent?.gatewayOrderId) return { outcome: "UNKNOWN_INTENT", intentId: refund.intentId };
    // The gateway's own record decides, not the webhook body.
    const truth = await gateway.fetchRefund(intent.gatewayOrderId, refund.merchantRefundId);
    if (truth.status === "PENDING") return { outcome: "REFUND_STILL_PENDING", intentId: intent.id };
    await settleRefund(refund.id, truth.status, { gatewayRefundId: truth.gatewayRefundId, source: "WEBHOOK", webhookEventId });
    return { outcome: `REFUND_${truth.status}`, intentId: intent.id };
  }

  const intent = await findIntentForEvent(gateway, event);
  if (!intent) return { outcome: "UNKNOWN_INTENT", intentId: null };
  const gatewayOrderId = intent.gatewayOrderId ?? event.gatewayOrderId;
  if (!gatewayOrderId) return { outcome: "UNKNOWN_INTENT", intentId: intent.id };
  const state = await gateway.fetchOrder(gatewayOrderId);
  const result = await applyGatewayState(intent.id, state, { source: "WEBHOOK", webhookEventId });
  return { outcome: result.outcome, intentId: intent.id };
}

/** POST /api/webhooks/payments/[gateway]. */
export async function handlePaymentWebhook(gatewayParam: string, rawBody: string, headers: Headers): Promise<WebhookResponse> {
  const name = parseGatewayName(gatewayParam);
  if (!name) return { status: 404, body: { error: "Unknown gateway" } };
  const gateway = getGatewayByName(name);
  if (!gateway.isConfigured() || (name === "SANDBOX" && !(await sandboxAllowed()))) {
    // Nothing to verify against: refuse rather than accept an unauthenticated payload.
    return { status: 503, body: { error: "Webhook not configured" } };
  }

  if (!gateway.verifyWebhook(rawBody, headers)) {
    await db.insert(paymentWebhookEvents).values({
      gateway: name,
      eventId: `rejected:${randomUUID()}`,
      signatureOk: false,
      outcome: "BAD_SIGNATURE",
      processedAt: new Date(),
      rawPayload: payloadFor(rawBody),
    });
    await recordAudit({
      action: AUDIT_ACTIONS.PAYMENT_WEBHOOK_REJECTED,
      entityType: "payment_webhook",
      newValue: { gateway: name, reason: "bad signature or stale timestamp" },
    });
    return { status: 401, body: { error: "Invalid signature" } };
  }

  let event: GatewayWebhookEvent;
  try {
    event = gateway.parseWebhook(rawBody, headers);
  } catch {
    await db.insert(paymentWebhookEvents).values({
      gateway: name,
      eventId: `malformed:${randomUUID()}`,
      signatureOk: true,
      outcome: "MALFORMED",
      processedAt: new Date(),
      rawPayload: payloadFor(rawBody),
    });
    return { status: 400, body: { error: "Malformed payload" } };
  }

  const [inserted] = await db
    .insert(paymentWebhookEvents)
    .values({ gateway: name, eventId: event.eventId, kind: event.kind, signatureOk: true, rawPayload: payloadFor(rawBody) })
    .onConflictDoNothing()
    .returning({ id: paymentWebhookEvents.id });
  let rowId = inserted?.id;
  if (!rowId) {
    const [existing] = await db
      .select()
      .from(paymentWebhookEvents)
      .where(and(eq(paymentWebhookEvents.gateway, name), eq(paymentWebhookEvents.eventId, event.eventId)));
    if (!existing || existing.processedAt) return { status: 200, body: { received: true, duplicate: true } };
    // Seen before but its processing failed: this redelivery is the retry.
    rowId = existing.id;
  }

  try {
    const { outcome, intentId } = await processEvent(gateway, event, rowId);
    await db
      .update(paymentWebhookEvents)
      .set({ processedAt: new Date(), outcome, intentId, error: null })
      .where(eq(paymentWebhookEvents.id, rowId));
    return { status: 200, body: { received: true, outcome } };
  } catch (error) {
    console.error("[payments] webhook processing failed", name, event.eventId, error);
    await db
      .update(paymentWebhookEvents)
      .set({ outcome: "ERROR", error: error instanceof Error ? error.message.slice(0, 500) : String(error) })
      .where(eq(paymentWebhookEvents.id, rowId));
    // Non-2xx: the gateway retries, and the retry processes it (processed_at is still empty).
    return { status: 500, body: { error: "Processing failed" } };
  }
}

/* ------------------------------------------------------ reconciliation */

export interface ReconcileResult {
  checked: number;
  moved: number;
  refundsSubmitted: number;
  refundsSettled: number;
  orphanOrders: number;
  errors: string[];
}

/**
 * The reconciliation job (cron payments-reconcile): attempts still open
 * `reconcileAfterMinutes` after they started (or past their expiry) are
 * checked with the gateway; queued refunds are sent; pending refunds are
 * polled. Runs whether or not rule onlinePayments is on, so attempts opened
 * before it was switched off still finish.
 */
export async function runPaymentReconciliation(now: Date = new Date()): Promise<ReconcileResult> {
  const rules = await getRule("onlinePayments");
  const result: ReconcileResult = { checked: 0, moved: 0, refundsSubmitted: 0, refundsSettled: 0, orphanOrders: 0, errors: [] };
  const cutoff = new Date(now.getTime() - rules.reconcileAfterMinutes * 60_000);

  const stuck = await db
    .select()
    .from(paymentIntents)
    .where(
      and(
        inArray(paymentIntents.status, [...LIVE_PAYMENT_INTENT_STATUSES]),
        or(lt(paymentIntents.createdAt, cutoff), lt(paymentIntents.expiresAt, now)),
      ),
    )
    .orderBy(asc(paymentIntents.createdAt))
    .limit(100);
  for (const intent of stuck) {
    result.checked += 1;
    try {
      const applied = await reconcileIntent(intent.id, "RECONCILE");
      if (applied.outcome === "MOVED") result.moved += 1;
      else if (intent.reconcileAttempts + 1 >= rules.maxReconcileAttempts) {
        await flagPaymentForSupport(db, intent, `Still not settled after ${rules.maxReconcileAttempts} checks with the gateway.`, "stuck");
      }
    } catch (error) {
      result.errors.push(`intent ${intent.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pending = await db
    .select()
    .from(paymentRefunds)
    .where(eq(paymentRefunds.status, "PENDING"))
    .orderBy(asc(paymentRefunds.createdAt))
    .limit(100);
  for (const refund of pending) {
    try {
      if (!refund.submittedAt) {
        const sent = await submitRefund(refund.id);
        if (sent.submittedAt) result.refundsSubmitted += 1;
        if (sent.status !== "PENDING") result.refundsSettled += 1;
        continue;
      }
      const intent = await getPaymentIntentRow(refund.intentId);
      if (!intent?.gatewayOrderId) continue;
      const truth = await getGatewayByName(intent.gateway).fetchRefund(intent.gatewayOrderId, refund.merchantRefundId);
      if (truth.status === "PENDING") {
        const [polled] = await db
          .update(paymentRefunds)
          .set({ pollAttempts: sql`${paymentRefunds.pollAttempts} + 1`, updatedAt: new Date() })
          .where(eq(paymentRefunds.id, refund.id))
          .returning();
        if (polled.pollAttempts === rules.maxReconcileAttempts) {
          await flagPaymentForSupport(db, intent, `A refund of ${refund.amountPaise} paise is still pending at the gateway.`, `refund-stuck:${refund.id}`);
        }
        continue;
      }
      await settleRefund(refund.id, truth.status, { gatewayRefundId: truth.gatewayRefundId, source: "RECONCILE" });
      result.refundsSettled += 1;
    } catch (error) {
      result.errors.push(`refund ${refund.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Online orders whose payment never opened (the gateway call failed and the customer left).
  const orphanCutoff = new Date(now.getTime() - (rules.intentExpiryMinutes + rules.reconcileAfterMinutes) * 60_000);
  const orphans = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.paymentMethod, "ONLINE"),
        eq(orders.status, "PENDING"),
        lt(orders.createdAt, orphanCutoff),
        sql`NOT EXISTS (SELECT 1 FROM payment_intents pi WHERE (pi.purpose = 'ORDER' AND pi.reference_id = ${orders.id})
             OR (pi.purpose = 'ORDER_GROUP' AND ${orders.orderGroupId} IS NOT NULL AND pi.reference_id = ${orders.orderGroupId}))`,
      ),
    )
    .limit(100);
  if (orphans.length > 0) {
    const { failOrphanOnlineOrder } = await import("./order-payments");
    for (const orphan of orphans) {
      try {
        if (await failOrphanOnlineOrder(orphan.id)) result.orphanOrders += 1;
      } catch (error) {
        result.errors.push(`order ${orphan.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return result;
}

/** Recent webhook deliveries that failed processing (for an operator's eye; not retried by us — the gateway retries). */
export async function listFailedWebhooks(limit = 50) {
  return db
    .select()
    .from(paymentWebhookEvents)
    .where(and(eq(paymentWebhookEvents.outcome, "ERROR"), isNull(paymentWebhookEvents.processedAt)))
    .orderBy(asc(paymentWebhookEvents.receivedAt))
    .limit(limit);
}
