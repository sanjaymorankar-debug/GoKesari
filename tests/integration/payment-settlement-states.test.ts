/**
 * PAY-SM (docs/payment-settlement-states-2026-11.md): RECONCILED from the payments job and
 * CHARGEBACK from Cashfree's dispute webhook, against a real PostgreSQL. The gateway is
 * Cashfree with its network calls replaced; webhooks are signed with the test secret and go
 * through the real route.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { NextRequest } from "next/server";

import { POST as webhookRoute } from "@/app/api/webhooks/payments/[gateway]/route";
import { paymentsReconcile } from "@/server/cron/schedule";
import { db } from "@/server/db";
import {
  auditLogs,
  domainEvents,
  featureFlags,
  notifications,
  paymentChargebacks,
  paymentIntentEvents,
  paymentIntents,
  paymentWebhookEvents,
  platformSettings,
  type PaymentIntentRow,
} from "@/server/db/schema";
import { CashfreeGateway } from "@/server/payments/gateway/cashfree";
import { hmacBase64 } from "@/server/payments/gateway/common";
import { setGatewayOverrideForTests } from "@/server/payments/gateway/registry";
import type { GatewayOrderState } from "@/server/payments/gateway/types";
import { listChargebacks, runSettlementReconciliation } from "@/server/payments/settlement";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";
import { createUser, resetDatabase } from "../helpers/fixtures";

const SECRET = "test-webhook-secret"; // tests/setup.ts: CASHFREE_SECRET_KEY

/** Cashfree with keys "set" and fetchOrder answered from `answers` (or thrown). */
class FakeCashfree extends CashfreeGateway {
  answers = new Map<string, GatewayOrderState | Error>();
  calls = 0;
  override isConfigured(): boolean {
    return true;
  }
  override async fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState> {
    this.calls += 1;
    const answer = this.answers.get(gatewayOrderId);
    if (!answer) throw new Error(`no answer for ${gatewayOrderId}`);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
let gateway: FakeCashfree;

async function flag(enabled: boolean) {
  await db.insert(featureFlags).values({ key: "payment_settlement_states", enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
  clearFeatureFlagCache();
}

const HOUR = 3_600_000;

async function paidIntent(over: Partial<typeof paymentIntents.$inferInsert> = {}): Promise<PaymentIntentRow> {
  const id = randomUUID();
  const merchantOrderId = `gk_${id.replace(/-/g, "")}`;
  const [row] = await db
    .insert(paymentIntents)
    .values({
      id,
      purpose: "ORDER",
      referenceId: randomUUID(),
      amountPaise: 25_000,
      gateway: "CASHFREE",
      merchantOrderId,
      gatewayOrderId: merchantOrderId,
      gatewayPaymentId: "5114910000001",
      idempotencyKey: `test:${id}`,
      description: "Order GK-1001",
      status: "CAPTURED",
      capturedAt: new Date(Date.now() - 2 * HOUR),
      ...over,
    })
    .returning();
  return row;
}

function captured(row: PaymentIntentRow, over: Partial<GatewayOrderState> = {}): GatewayOrderState {
  return { gatewayOrderId: row.gatewayOrderId!, status: "CAPTURED", amountPaise: row.amountPaise, gatewayPaymentId: row.gatewayPaymentId, method: "UPI", ...over };
}

const intentOf = async (id: string) => (await db.query.paymentIntents.findFirst({ where: eq(paymentIntents.id, id) }))!;
const eventsOf = async (type: string) => db.select().from(domainEvents).where(eq(domainEvents.type, type));

function disputeBody(orderId: string, over: Record<string, unknown> = {}, type = "DISPUTE_CREATED") {
  return JSON.stringify({
    type,
    event_time: "2026-11-24T10:00:00+05:30",
    data: {
      dispute: {
        dispute_id: "433475257",
        dispute_type: "CHARGEBACK",
        reason_code: "4855",
        reason_description: "Goods or Services not provided",
        dispute_amount: 250,
        created_at: "2026-11-24T09:59:00+05:30",
        updated_at: "2026-11-24T10:00:00+05:30",
        respond_by: "2026-11-27T23:59:00+05:30",
        resolved_at: null,
        dispute_status: "CHARGEBACK_CREATED",
        ...over,
      },
      order_details: { order_id: orderId, cf_payment_id: 5114910000001, payment_amount: 250 },
    },
  });
}

async function postCashfree(rawBody: string, options: { badSignature?: boolean } = {}) {
  const timestamp = String(Date.now());
  const signature = options.badSignature ? "AAAA" : hmacBase64(SECRET, timestamp + rawBody);
  const request = new NextRequest("http://localhost/api/webhooks/payments/cashfree", {
    method: "POST",
    body: rawBody,
    headers: { "content-type": "application/json", "x-webhook-signature": signature, "x-webhook-timestamp": timestamp },
  });
  const response = await webhookRoute(request, { params: Promise.resolve({ gateway: "cashfree" }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`TRUNCATE TABLE payment_chargebacks, payment_webhook_events, payment_refunds, payment_intent_events, payment_intents CASCADE`);
  await db.delete(platformSettings).where(eq(platformSettings.key, "paymentSettlement"));
  clearRuleCache();
  gateway = new FakeCashfree();
  setGatewayOverrideForTests("CASHFREE", gateway);
});

afterEach(() => {
  setGatewayOverrideForTests("CASHFREE", null);
});

describe("flag off (the default)", () => {
  it("PAYSM-01 the reconcile step and a dispute webhook change nothing", async () => {
    const intent = await paidIntent();
    gateway.answers.set(intent.gatewayOrderId!, captured(intent));
    expect(await runSettlementReconciliation()).toMatchObject({ skipped: true, reason: "FLAG_OFF", checked: 0 });
    expect(gateway.calls).toBe(0);

    const res = await postCashfree(disputeBody(intent.merchantOrderId));
    expect(res).toMatchObject({ status: 200, body: { received: true, outcome: "DISPUTE_FLAG_OFF" } });
    expect(await db.select().from(paymentChargebacks)).toHaveLength(0);
    expect(await intentOf(intent.id)).toMatchObject({ settlementState: null, status: "CAPTURED" });
    // The delivery is still logged (and de-duplicated) like any other webhook.
    expect(await db.select().from(paymentWebhookEvents)).toHaveLength(1);
  });
});

describe("RECONCILED", () => {
  it("PAYSM-02 a captured payment the gateway confirms becomes RECONCILED, recorded and audited, once", async () => {
    await flag(true);
    const intent = await paidIntent();
    gateway.answers.set(intent.gatewayOrderId!, captured(intent));

    const job = await paymentsReconcile();
    expect(job.settlement).toMatchObject({ checked: 1, reconciled: 1, unconfirmed: 0, errors: [] });
    const after = await intentOf(intent.id);
    expect(after).toMatchObject({ settlementState: "RECONCILED", status: "CAPTURED", settlementChecks: 1 });
    expect(after.reconciledAt).not.toBeNull();
    const history = await db.select().from(paymentIntentEvents).where(eq(paymentIntentEvents.intentId, intent.id));
    expect(history).toEqual([expect.objectContaining({ fromStatus: "CAPTURED", toStatus: "RECONCILED", source: "RECONCILE" })]);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, intent.id), eq(auditLogs.action, "payment.settlement_state_changed")));
    expect(audit).toHaveLength(1);

    // Idempotent: the next run asks nothing.
    expect(await runSettlementReconciliation()).toMatchObject({ checked: 0, reconciled: 0 });
    expect(gateway.calls).toBe(1);
  });

  it("PAYSM-03 refunded payments are confirmed too; fresh, unpaid and old ones are not asked about", async () => {
    await flag(true);
    const refunded = await paidIntent({ status: "PARTIALLY_REFUNDED", refundedPaise: 5_000 });
    gateway.answers.set(refunded.gatewayOrderId!, captured(refunded));
    await paidIntent({ capturedAt: new Date(Date.now() - 5 * 60_000) }); // captured 5 minutes ago (< 30)
    await paidIntent({ status: "PENDING", capturedAt: null });
    await paidIntent({ capturedAt: new Date(Date.now() - 60 * 24 * HOUR) }); // beyond the 45-day look-back
    const result = await runSettlementReconciliation();
    expect(result).toMatchObject({ checked: 1, reconciled: 1 });
    expect((await intentOf(refunded.id)).settlementState).toBe("RECONCILED");
  });

  it("PAYSM-04 a gateway that disagrees: not reconciled, support told once per answer, then the job gives up", async () => {
    await flag(true);
    await db.insert(platformSettings).values({ key: "paymentSettlement", value: { maxChecks: 2, recheckMinutes: 5 } });
    clearRuleCache();
    const intent = await paidIntent();
    gateway.answers.set(intent.gatewayOrderId!, captured(intent, { amountPaise: 24_999 }));

    expect(await runSettlementReconciliation()).toMatchObject({ checked: 1, reconciled: 0, unconfirmed: 1 });
    expect(await intentOf(intent.id)).toMatchObject({ settlementState: null, settlementChecks: 1 });
    expect(await eventsOf("payment.attention")).toHaveLength(1);

    // Not again until recheckMinutes have passed.
    expect((await runSettlementReconciliation()).checked).toBe(0);
    await db.update(paymentIntents).set({ settlementCheckedAt: new Date(Date.now() - HOUR) }).where(eq(paymentIntents.id, intent.id));
    expect(await runSettlementReconciliation()).toMatchObject({ checked: 1, unconfirmed: 1 });
    // Same answer: no second "not reconciled" alert; maxChecks reached: one "gave up" alert.
    const attention = await eventsOf("payment.attention");
    expect(attention).toHaveLength(2);
    expect(attention.map((e) => (e.payload as { problem: string }).problem).join(" | ")).toMatch(/after 2 checks/);

    await db.update(paymentIntents).set({ settlementCheckedAt: new Date(Date.now() - HOUR) }).where(eq(paymentIntents.id, intent.id));
    expect((await runSettlementReconciliation()).checked).toBe(0);
  });

  it("PAYSM-05 a gateway error is counted and reported, and does not stop the other payments", async () => {
    await flag(true);
    const broken = await paidIntent({ capturedAt: new Date(Date.now() - 3 * HOUR) });
    const good = await paidIntent();
    gateway.answers.set(broken.gatewayOrderId!, new Error("cashfree get order: HTTP 502"));
    gateway.answers.set(good.gatewayOrderId!, captured(good));
    const result = await runSettlementReconciliation();
    expect(result).toMatchObject({ checked: 2, reconciled: 1 });
    expect(result.errors).toEqual([expect.stringContaining("HTTP 502")]);
    expect(await intentOf(broken.id)).toMatchObject({ settlementState: null, settlementChecks: 1 });
    expect((await intentOf(good.id)).settlementState).toBe("RECONCILED");
  });
});

describe("CHARGEBACK", () => {
  it("PAYSM-06 a bad signature is refused with 401 and records nothing", async () => {
    await flag(true);
    const intent = await paidIntent();
    const res = await postCashfree(disputeBody(intent.merchantOrderId), { badSignature: true });
    expect(res.status).toBe(401);
    expect(await db.select().from(paymentChargebacks)).toHaveLength(0);
    expect((await intentOf(intent.id)).settlementState).toBeNull();
  });

  it("PAYSM-07 a dispute marks the payment CHARGEBACK, records amount / reason / deadline and alerts the admins", async () => {
    await flag(true);
    const admin = await createUser({ role: "ADMIN" });
    const operator = await createUser({ role: "OPERATOR" });
    const intent = await paidIntent({ settlementState: "RECONCILED", reconciledAt: new Date() });

    const res = await postCashfree(disputeBody(intent.merchantOrderId));
    expect(res).toMatchObject({ status: 200, body: { received: true, outcome: "CHARGEBACK_RECORDED" } });

    const [cb] = await db.select().from(paymentChargebacks);
    expect(cb).toMatchObject({
      gateway: "CASHFREE",
      gatewayDisputeId: "433475257",
      intentId: intent.id,
      disputeType: "CHARGEBACK",
      gatewayStatus: "CHARGEBACK_CREATED",
      outcome: "OPEN",
      amountPaise: 25_000,
      reasonCode: "4855",
      reason: "Goods or Services not provided",
      gatewayPaymentId: "5114910000001",
    });
    expect(cb.respondBy!.toISOString()).toBe("2026-11-27T18:29:00.000Z");
    expect(await intentOf(intent.id)).toMatchObject({ settlementState: "CHARGEBACK", status: "CAPTURED" });
    const history = await db.select().from(paymentIntentEvents).where(eq(paymentIntentEvents.intentId, intent.id));
    expect(history).toEqual([expect.objectContaining({ fromStatus: "RECONCILED", toStatus: "CHARGEBACK", source: "WEBHOOK" })]);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "payment.chargeback_recorded"))).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "payment.settlement_state_changed"))).toHaveLength(1);

    expect(await eventsOf("payment.chargeback")).toHaveLength(1);
    const adminNotes = await db.select().from(notifications).where(eq(notifications.userId, admin.id));
    expect(adminNotes.map((n) => n.type)).toContain("support.payment_chargeback");
    // Admins only (SUPPORT_LEAD), not every operator.
    const operatorNotes = await db.select().from(notifications).where(eq(notifications.userId, operator.id));
    expect(operatorNotes.map((n) => n.type)).not.toContain("support.payment_chargeback");

    // The dispute's respond_by is fixed (27-Nov-2026 23:59 IST): read the list as of before it, not today.
    const [view] = await listChargebacks(200, new Date("2026-11-25T10:00:00+05:30"));
    expect(view).toMatchObject({ outcome: "OPEN", overdue: false, amountPaise: 25_000, intentAmountPaise: 25_000, description: "Order GK-1001" });
  });

  it("PAYSM-08 a repeated event is ignored; a later outcome updates and alerts again; an older one changes nothing", async () => {
    await flag(true);
    await createUser({ role: "ADMIN" });
    const intent = await paidIntent();
    const opened = disputeBody(intent.merchantOrderId);
    expect((await postCashfree(opened)).body.outcome).toBe("CHARGEBACK_RECORDED");
    expect(await postCashfree(opened)).toMatchObject({ status: 200, body: { duplicate: true } });

    const won = disputeBody(
      intent.merchantOrderId,
      { dispute_status: "CHARGEBACK_MERCHANT_WON", updated_at: "2026-11-26T12:00:00+05:30", resolved_at: "2026-11-26T12:00:00+05:30" },
      "DISPUTE_CLOSED",
    );
    expect((await postCashfree(won)).body.outcome).toBe("CHARGEBACK_UPDATED");
    const [cb] = await db.select().from(paymentChargebacks);
    expect(cb).toMatchObject({ outcome: "WON", gatewayStatus: "CHARGEBACK_MERCHANT_WON" });
    expect(cb.resolvedAt).not.toBeNull();
    expect(await eventsOf("payment.chargeback")).toHaveLength(2);
    // Still CHARGEBACK (the outcome lives on the dispute), and only one state change was written.
    expect((await intentOf(intent.id)).settlementState).toBe("CHARGEBACK");
    expect(await db.select().from(paymentIntentEvents).where(eq(paymentIntentEvents.intentId, intent.id))).toHaveLength(1);

    const late = disputeBody(intent.merchantOrderId, { dispute_status: "DISPUTE_UNDER_REVIEW", updated_at: "2026-11-25T08:00:00+05:30" }, "DISPUTE_UPDATED");
    expect((await postCashfree(late)).body.outcome).toBe("DISPUTE_STALE");
    expect((await db.select().from(paymentChargebacks))[0].outcome).toBe("WON");
    expect(await eventsOf("payment.chargeback")).toHaveLength(2);
  });

  it("PAYSM-09 a dispute for a payment that is not ours is still recorded and alerted; reconcile skips charged-back payments", async () => {
    await flag(true);
    await createUser({ role: "ADMIN" });
    const res = await postCashfree(disputeBody("CF_TOPUP_123"));
    expect(res.body.outcome).toBe("CHARGEBACK_RECORDED");
    const [cb] = await db.select().from(paymentChargebacks);
    expect(cb.intentId).toBeNull();
    expect(await eventsOf("payment.chargeback")).toHaveLength(1);

    const disputed = await paidIntent({ settlementState: "CHARGEBACK" });
    gateway.answers.set(disputed.gatewayOrderId!, captured(disputed));
    expect((await runSettlementReconciliation()).checked).toBe(0);
  });
});
