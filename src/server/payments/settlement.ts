/**
 * PAY-SM — what happens to an online payment after the money is taken
 * (docs/payment-settlement-states-2026-11.md). Behind feature flag
 * payment_settlement_states (OFF by default): with it off nothing here changes
 * a row, and dispute webhooks are only logged in payment_webhook_events.
 *
 *  - RECONCILED: the payments job (cron payments-reconcile, every 5 minutes)
 *    asks the gateway about each paid intent not yet confirmed. When the
 *    gateway's own record shows the same payment captured for the same amount,
 *    the intent is marked RECONCILED. A different answer alerts support once
 *    per distinct answer; after `maxChecks` unconfirmed checks the job stops
 *    asking and alerts support. Idempotent: a confirmed intent is never asked
 *    about again, and the move re-checks the state under a row lock.
 *  - CHARGEBACK: a signed dispute webhook (already verified and de-duplicated
 *    by event id in processing.ts) is recorded in payment_chargebacks (amount
 *    in paise, reason, respond-by deadline, outcome), the intent is marked
 *    CHARGEBACK, and the admins are told — once when it opens and once per
 *    change of outcome.
 *
 * The gateway call is always made outside the database transaction. Every
 * state change writes payment_intent_events and the audit log.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { formatPaise } from "@/lib/money";
import {
  canMoveSettlement,
  PAID_PAYMENT_INTENT_STATUSES,
  PAYMENT_SETTLEMENT_LABELS,
  type PaymentSettlementState,
} from "@/lib/payment-intent-states";
import { db, type DbClient } from "@/server/db";
import { paymentChargebacks, paymentIntentEvents, paymentIntents, type PaymentChargebackRow, type PaymentIntentRow } from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { getGatewayByName } from "./gateway/registry";
import type { GatewayName, GatewayOrderState, GatewayWebhookEvent } from "./gateway/types";
import { flagPaymentForSupport, lockIntent, type IntentSource } from "./intent-store";

export const SETTLEMENT_FLAG = "payment_settlement_states" as const;

export async function settlementStatesEnabled(): Promise<boolean> {
  return isFeatureEnabled(SETTLEMENT_FLAG);
}

interface SettlementMoveOptions {
  source: IntentSource;
  note: string;
  webhookEventId?: string | null;
  patch?: Partial<typeof paymentIntents.$inferInsert>;
}

/**
 * Moves a LOCKED intent's settlement state. Returns null (nothing written)
 * when the move is not allowed — e.g. a second chargeback on a payment that is
 * already CHARGEBACK.
 */
export async function moveSettlementState(
  client: DbClient,
  row: PaymentIntentRow,
  to: PaymentSettlementState,
  options: SettlementMoveOptions,
): Promise<PaymentIntentRow | null> {
  const from = row.settlementState ?? null;
  if (!canMoveSettlement(from, to)) return null;
  const [updated] = await client
    .update(paymentIntents)
    .set({ ...options.patch, settlementState: to, updatedAt: new Date() })
    .where(eq(paymentIntents.id, row.id))
    .returning();
  await client.insert(paymentIntentEvents).values({
    intentId: row.id,
    fromStatus: from ?? row.status,
    toStatus: to,
    source: options.source,
    note: options.note,
    webhookEventId: options.webhookEventId ?? null,
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.PAYMENT_SETTLEMENT_STATE_CHANGED,
      entityType: "payment_intent",
      entityId: row.id,
      previousValue: { settlementState: from, status: row.status },
      newValue: { settlementState: to, source: options.source, note: options.note },
    },
    client,
  );
  return updated;
}

/* --------------------------------------------------------------- RECONCILED */

export type SettlementCheck = "CONFIRMED" | "NOT_CAPTURED" | "AMOUNT_MISMATCH" | "PAYMENT_MISMATCH";

/** Does the gateway's record confirm this captured intent? Pure: the unit tests call it directly. */
export function compareWithGateway(row: Pick<PaymentIntentRow, "amountPaise" | "gatewayPaymentId">, state: GatewayOrderState): SettlementCheck {
  if (state.status !== "CAPTURED") return "NOT_CAPTURED";
  if (state.amountPaise !== row.amountPaise) return "AMOUNT_MISMATCH";
  if (row.gatewayPaymentId && state.gatewayPaymentId && row.gatewayPaymentId !== state.gatewayPaymentId) return "PAYMENT_MISMATCH";
  return "CONFIRMED";
}

export interface SettlementRunResult {
  skipped?: true;
  reason?: string;
  checked: number;
  reconciled: number;
  unconfirmed: number;
  errors: string[];
}

/** Paid intents due for a check: not confirmed yet, old enough, not checked recently, within the look-back. */
async function dueForCheck(now: Date) {
  const rules = await getRule("paymentSettlement");
  const capturedBefore = new Date(now.getTime() - rules.checkAfterMinutes * 60_000);
  const capturedAfter = new Date(now.getTime() - rules.lookbackDays * 86_400_000);
  const checkedBefore = new Date(now.getTime() - rules.recheckMinutes * 60_000);
  const rows = await db
    .select()
    .from(paymentIntents)
    .where(
      and(
        isNull(paymentIntents.settlementState),
        inArray(paymentIntents.status, [...PAID_PAYMENT_INTENT_STATUSES]),
        lt(paymentIntents.capturedAt, capturedBefore),
        gt(paymentIntents.capturedAt, capturedAfter),
        sql`${paymentIntents.gatewayOrderId} IS NOT NULL`,
        lt(paymentIntents.settlementChecks, rules.maxChecks),
        or(isNull(paymentIntents.settlementCheckedAt), lt(paymentIntents.settlementCheckedAt, checkedBefore)),
      ),
    )
    .orderBy(asc(paymentIntents.capturedAt))
    .limit(rules.batchSize);
  return { rows, rules };
}

/**
 * Confirms one paid intent with the gateway. The gateway is asked first
 * (no transaction open); the answer is applied under the intent's row lock.
 */
export async function reconcileSettlement(intent: PaymentIntentRow, maxChecks: number, now: Date = new Date()): Promise<SettlementCheck | "ALREADY_SET"> {
  const state = await getGatewayByName(intent.gateway).fetchOrder(intent.gatewayOrderId!);
  const check = compareWithGateway(intent, state);
  return db.transaction(async (tx) => {
    const row = await lockIntent(tx, intent.id);
    if (!row || row.settlementState) return "ALREADY_SET" as const;
    const counters = { settlementCheckedAt: now, settlementChecks: row.settlementChecks + 1 };
    if (check === "CONFIRMED") {
      await moveSettlementState(tx, row, "RECONCILED", {
        source: "RECONCILE",
        note: `Gateway confirmed ${state.gatewayPaymentId ? `payment ${state.gatewayPaymentId}` : "the payment"} of ${formatPaise(state.amountPaise)}`,
        patch: { ...counters, reconciledAt: now },
      });
      return check;
    }
    await tx.update(paymentIntents).set(counters).where(eq(paymentIntents.id, row.id));
    const problem =
      check === "NOT_CAPTURED"
        ? `We hold this payment as ${row.status}, but the gateway reports it as ${state.status}.`
        : check === "AMOUNT_MISMATCH"
          ? `We took ${formatPaise(row.amountPaise)}, but the gateway reports ${formatPaise(state.amountPaise)} captured.`
          : `The gateway reports payment ${state.gatewayPaymentId}, not ${row.gatewayPaymentId}.`;
    // Once per distinct answer: a later run with the same answer does not repeat the alert.
    await flagPaymentForSupport(tx, row, `Not reconciled: ${problem}`, `settlement:${check}:${state.status}:${state.amountPaise}`);
    if (counters.settlementChecks >= maxChecks) {
      await flagPaymentForSupport(tx, row, `Not reconciled after ${maxChecks} checks with the gateway; the job has stopped asking.`, "settlement:gave-up");
    }
    return check;
  });
}

/** The RECONCILED step of the payments job. A no-op while the flag is off. */
export async function runSettlementReconciliation(now: Date = new Date()): Promise<SettlementRunResult> {
  const result: SettlementRunResult = { checked: 0, reconciled: 0, unconfirmed: 0, errors: [] };
  if (!(await settlementStatesEnabled())) return { ...result, skipped: true, reason: "FLAG_OFF" };
  const { rows, rules } = await dueForCheck(now);
  for (const intent of rows) {
    result.checked += 1;
    try {
      const outcome = await reconcileSettlement(intent, rules.maxChecks, now);
      if (outcome === "CONFIRMED") result.reconciled += 1;
      else if (outcome !== "ALREADY_SET") result.unconfirmed += 1;
    } catch (error) {
      // The gateway could not be asked: count the try so a broken intent cannot block the queue forever.
      await db
        .update(paymentIntents)
        .set({ settlementCheckedAt: now, settlementChecks: sql`${paymentIntents.settlementChecks} + 1` })
        .where(and(eq(paymentIntents.id, intent.id), isNull(paymentIntents.settlementState)));
      result.errors.push(`intent ${intent.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/* --------------------------------------------------------------- CHARGEBACK */

async function findIntentForDispute(gateway: GatewayName, event: GatewayWebhookEvent): Promise<PaymentIntentRow | undefined> {
  const conditions = [];
  if (event.merchantRef) conditions.push(eq(paymentIntents.merchantOrderId, event.merchantRef));
  if (event.gatewayOrderId) conditions.push(and(eq(paymentIntents.gateway, gateway), eq(paymentIntents.gatewayOrderId, event.gatewayOrderId)));
  if (event.gatewayPaymentId) conditions.push(and(eq(paymentIntents.gateway, gateway), eq(paymentIntents.gatewayPaymentId, event.gatewayPaymentId)));
  if (conditions.length === 0) return undefined;
  const [row] = await db.select().from(paymentIntents).where(or(...conditions)).limit(1);
  return row;
}

function istDate(value: Date | null): string {
  if (!value) return "no date given";
  return value.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) + " IST";
}

export type DisputeOutcome = "DISPUTE_FLAG_OFF" | "CHARGEBACK_RECORDED" | "CHARGEBACK_UPDATED" | "DISPUTE_STALE";

/**
 * Applies one verified, de-duplicated dispute webhook (processing.ts calls
 * this for kind DISPUTE). Out-of-order deliveries are safe: an event older
 * than the one last applied changes nothing.
 */
export async function applyDisputeEvent(
  gateway: GatewayName,
  event: GatewayWebhookEvent,
  webhookEventId: string,
): Promise<{ outcome: DisputeOutcome; intentId: string | null }> {
  const dispute = event.dispute;
  if (!dispute) throw new Error("dispute event without dispute details");
  if (!(await settlementStatesEnabled())) return { outcome: "DISPUTE_FLAG_OFF", intentId: null };
  const intent = await findIntentForDispute(gateway, event);

  return db.transaction(async (tx) => {
    const values = {
      intentId: intent?.id ?? null,
      gatewayOrderId: event.gatewayOrderId,
      gatewayPaymentId: event.gatewayPaymentId,
      disputeType: dispute.disputeType,
      gatewayStatus: dispute.gatewayStatus,
      outcome: dispute.outcome,
      amountPaise: dispute.amountPaise,
      reasonCode: dispute.reasonCode,
      reason: dispute.reason,
      respondBy: dispute.respondBy,
      openedAt: dispute.openedAt,
      resolvedAt: dispute.resolvedAt,
      lastEventAt: dispute.updatedAt,
      lastWebhookEventId: webhookEventId,
    };
    const [created] = await tx
      .insert(paymentChargebacks)
      .values({ gateway, gatewayDisputeId: dispute.disputeId, ...values })
      .onConflictDoNothing()
      .returning();
    let row: PaymentChargebackRow;
    let previousOutcome: string | null = null;
    if (created) {
      row = created;
    } else {
      const [existing] = await tx
        .select()
        .from(paymentChargebacks)
        .where(and(eq(paymentChargebacks.gateway, gateway), eq(paymentChargebacks.gatewayDisputeId, dispute.disputeId)))
        .for("update");
      if (dispute.updatedAt.getTime() < existing.lastEventAt.getTime()) return { outcome: "DISPUTE_STALE" as const, intentId: existing.intentId };
      previousOutcome = existing.outcome;
      [row] = await tx
        .update(paymentChargebacks)
        .set({ ...values, intentId: existing.intentId ?? values.intentId, updatedAt: new Date() })
        .where(eq(paymentChargebacks.id, existing.id))
        .returning();
    }
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_CHARGEBACK_RECORDED,
        entityType: "payment_chargeback",
        entityId: row.id,
        previousValue: created ? null : { outcome: previousOutcome },
        newValue: {
          gateway,
          disputeId: dispute.disputeId,
          intentId: row.intentId,
          gatewayStatus: dispute.gatewayStatus,
          outcome: dispute.outcome,
          amountPaise: dispute.amountPaise,
          respondBy: dispute.respondBy?.toISOString() ?? null,
        },
      },
      tx,
    );

    let intentRow: PaymentIntentRow | undefined;
    if (row.intentId) {
      intentRow = await lockIntent(tx, row.intentId);
      if (intentRow && intentRow.settlementState !== "CHARGEBACK") {
        await moveSettlementState(tx, intentRow, "CHARGEBACK", {
          source: "WEBHOOK",
          webhookEventId,
          note: `${dispute.disputeType ?? "Dispute"} ${dispute.disputeId}: ${formatPaise(dispute.amountPaise)}${dispute.reason ? ` — ${dispute.reason}` : ""}`,
        });
      }
    }

    if (created || previousOutcome !== row.outcome) {
      await emitEvent(
        {
          type: "payment.chargeback",
          subjectId: row.intentId ?? row.id,
          payload: {
            chargebackId: row.id,
            intentId: row.intentId,
            amount: formatPaise(row.amountPaise),
            reference: intentRow?.description ?? `Gateway order ${row.gatewayOrderId ?? "unknown"}`,
            outcome: row.outcome === "OPEN" ? "opened" : row.outcome.toLowerCase(),
            respondBy: istDate(row.respondBy),
            reason: row.reason ?? row.reasonCode ?? "no reason given",
          },
          idempotencyKey: `payment-chargeback:${row.id}:${row.outcome}`,
        },
        tx,
      );
    }
    return { outcome: created ? ("CHARGEBACK_RECORDED" as const) : ("CHARGEBACK_UPDATED" as const), intentId: row.intentId };
  });
}

/* ------------------------------------------------------------- admin view */

export interface ChargebackView {
  id: string;
  gateway: string;
  disputeId: string;
  disputeType: string | null;
  gatewayStatus: string;
  outcome: PaymentChargebackRow["outcome"];
  amountPaise: number;
  reasonCode: string | null;
  reason: string | null;
  respondBy: Date | null;
  openedAt: Date | null;
  resolvedAt: Date | null;
  intentId: string | null;
  purpose: PaymentIntentRow["purpose"] | null;
  referenceId: string | null;
  description: string | null;
  intentAmountPaise: number | null;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  updatedAt: Date;
  /** Still open and past its respond-by time. */
  overdue: boolean;
}

/** Open disputes first (nearest deadline first), then the rest, newest first. */
export async function listChargebacks(limit = 200, now: Date = new Date()): Promise<ChargebackView[]> {
  const rows = await db
    .select({ c: paymentChargebacks, i: paymentIntents })
    .from(paymentChargebacks)
    .leftJoin(paymentIntents, eq(paymentIntents.id, paymentChargebacks.intentId))
    .orderBy(sql`CASE WHEN ${paymentChargebacks.outcome} = 'OPEN' THEN 0 ELSE 1 END`, asc(paymentChargebacks.respondBy), desc(paymentChargebacks.updatedAt))
    .limit(limit);
  return rows.map(({ c, i }) => ({
    id: c.id,
    gateway: c.gateway,
    disputeId: c.gatewayDisputeId,
    disputeType: c.disputeType,
    gatewayStatus: c.gatewayStatus,
    outcome: c.outcome,
    amountPaise: c.amountPaise,
    reasonCode: c.reasonCode,
    reason: c.reason,
    respondBy: c.respondBy,
    openedAt: c.openedAt,
    resolvedAt: c.resolvedAt,
    intentId: c.intentId,
    purpose: i?.purpose ?? null,
    referenceId: i?.referenceId ?? null,
    description: i?.description ?? null,
    intentAmountPaise: i?.amountPaise ?? null,
    gatewayOrderId: c.gatewayOrderId,
    gatewayPaymentId: c.gatewayPaymentId,
    updatedAt: c.updatedAt,
    overdue: c.outcome === "OPEN" && c.respondBy !== null && c.respondBy.getTime() < now.getTime(),
  }));
}

export function settlementLabel(state: PaymentSettlementState | null): string | null {
  return state ? PAYMENT_SETTLEMENT_LABELS[state] : null;
}
