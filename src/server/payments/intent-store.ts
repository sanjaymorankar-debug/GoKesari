/**
 * Internal helpers for payment intents (batch-2026-10 WS-A): row → ref,
 * locking, and the one place an intent's status changes. Every move is
 * checked against the payment_intent state machine (lib/state-machines.ts),
 * recorded in payment_intent_events, audited, and emitted as an event (which
 * notifies the customer) — all in the caller's transaction.
 */
import { eq } from "drizzle-orm";

import { invalidTransition } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { PAYMENT_INTENT_STATUS_LABELS } from "@/lib/payment-intent-states";
import { canMove } from "@/lib/state-machines";
import type { DbClient } from "@/server/db";
import { paymentIntentEvents, paymentIntents, type PaymentIntentRow } from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import type { PaymentIntentRef, PaymentIntentStatus } from "./intents";

export type IntentSource = "API" | "WEBHOOK" | "RECONCILE" | "REFUND" | "SYSTEM";

export function toIntentRef(row: PaymentIntentRow): PaymentIntentRef {
  return {
    id: row.id,
    purpose: row.purpose,
    referenceId: row.referenceId,
    userId: row.userId,
    amountPaise: row.amountPaise,
    refundedPaise: row.refundedPaise,
    status: row.status,
    gateway: row.gateway,
    gatewayOrderId: row.gatewayOrderId,
    gatewayPaymentId: row.gatewayPaymentId,
  };
}

/** Our id for an attempt at the gateway: letters, digits and "_" only, 35 characters (fits every gateway's limit). */
export function merchantOrderIdFor(intentId: string): string {
  return `gk_${intentId.replace(/-/g, "")}`;
}

/** Where the customer follows an intent (the return page for orders; the caller's page otherwise). */
export function actionUrlFor(row: Pick<PaymentIntentRow, "id" | "purpose" | "returnPath">): string {
  const base = row.returnPath ?? "/orders/payment-return";
  return `${base}${base.includes("?") ? "&" : "?"}intent=${row.id}`;
}

export async function lockIntent(client: DbClient, intentId: string): Promise<PaymentIntentRow | undefined> {
  const [row] = await client.select().from(paymentIntents).where(eq(paymentIntents.id, intentId)).for("update");
  return row;
}

type PaymentEventType = "payment.pending" | "payment.authorized" | "payment.captured" | "payment.failed" | "payment.expired" | "payment.refunded";

function eventTypeFor(to: PaymentIntentStatus): PaymentEventType | null {
  switch (to) {
    case "PENDING":
      return "payment.pending";
    case "AUTHORIZED":
      return "payment.authorized";
    case "CAPTURED":
      return "payment.captured";
    case "FAILED":
      return "payment.failed";
    case "EXPIRED":
      return "payment.expired";
    case "PARTIALLY_REFUNDED":
    case "REFUNDED":
      return "payment.refunded";
    default:
      return null;
  }
}

export interface TransitionOptions {
  source: IntentSource;
  note?: string | null;
  webhookEventId?: string | null;
  /** Extra columns written with the status. */
  patch?: Partial<typeof paymentIntents.$inferInsert>;
  /** For payment.refunded: the amount refunded this time (defaults to the intent amount). */
  eventAmountPaise?: number;
  reason?: string | null;
  actor?: { id: string | null; role: import("@/server/db/schema").UserRole | null } | null;
}

/**
 * Moves a LOCKED intent row to `to`. Throws INVALID_STATE_TRANSITION (409)
 * when the state machine does not allow it.
 */
export async function transitionIntent(
  client: DbClient,
  row: PaymentIntentRow,
  to: PaymentIntentStatus,
  options: TransitionOptions,
): Promise<PaymentIntentRow> {
  if (!canMove("payment_intent", row.status, to)) {
    throw invalidTransition(PAYMENT_INTENT_STATUS_LABELS[row.status], PAYMENT_INTENT_STATUS_LABELS[to]);
  }
  const [updated] = await client
    .update(paymentIntents)
    .set({ ...options.patch, status: to, updatedAt: new Date() })
    .where(eq(paymentIntents.id, row.id))
    .returning();
  await client.insert(paymentIntentEvents).values({
    intentId: row.id,
    fromStatus: row.status,
    toStatus: to,
    source: options.source,
    note: options.note ?? null,
    webhookEventId: options.webhookEventId ?? null,
  });
  await recordAudit(
    {
      actorId: options.actor?.id ?? null,
      actorRole: options.actor?.role ?? null,
      action: AUDIT_ACTIONS.PAYMENT_INTENT_STATUS_CHANGED,
      entityType: "payment_intent",
      entityId: row.id,
      previousValue: { status: row.status },
      newValue: { status: to, source: options.source, note: options.note ?? null },
    },
    client,
  );
  const type = eventTypeFor(to);
  if (type) {
    await emitEvent(
      {
        type,
        subjectId: row.id,
        transition: { from: row.status, to },
        actor: options.actor ?? { id: null, role: null },
        payload: {
          intentId: row.id,
          userId: row.userId,
          amount: formatPaise(options.eventAmountPaise ?? row.amountPaise),
          reference: row.description,
          actionUrl: actionUrlFor(row),
          reason: options.reason ?? null,
        },
      },
      client,
    );
  }
  return updated;
}

/** Tells support a payment needs a person (no status change). */
export async function flagPaymentForSupport(client: DbClient, row: PaymentIntentRow, problem: string, dedupe: string): Promise<void> {
  await emitEvent(
    {
      type: "payment.attention",
      subjectId: row.id,
      payload: {
        intentId: row.id,
        userId: row.userId,
        amount: formatPaise(row.amountPaise),
        reference: row.description,
        actionUrl: actionUrlFor(row),
        problem,
      },
      idempotencyKey: `payment-attention:${row.id}:${dedupe}`,
    },
    client,
  );
}
