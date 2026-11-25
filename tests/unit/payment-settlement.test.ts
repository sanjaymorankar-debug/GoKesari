/**
 * PAY-SM (docs/payment-settlement-states-2026-11.md): the settlement state machine, the
 * gateway comparison that decides RECONCILED, and the Cashfree dispute webhook parser.
 */
import { describe, expect, it } from "vitest";

import { canMoveSettlement } from "@/lib/payment-intent-states";
import { cashfreeDisputeOutcome, CashfreeGateway, parseCashfreeDispute } from "@/server/payments/gateway/cashfree";
import { compareWithGateway } from "@/server/payments/settlement";

const state = (over: Partial<Parameters<typeof compareWithGateway>[1]> = {}) => ({
  gatewayOrderId: "gk_1",
  status: "CAPTURED" as const,
  amountPaise: 12_345,
  gatewayPaymentId: "pay_1",
  method: "UPI" as const,
  ...over,
});

/** A big cf_payment_id written as raw digits, as Cashfree sends it (JSON.parse would round it). */
function disputeBody(over: Record<string, unknown> = {}, type = "DISPUTE_CREATED") {
  return rawBody(over, type).replace('"__BIG__"', "9007199254740993123");
}

function rawBody(over: Record<string, unknown>, type: string) {
  return JSON.stringify({
    type,
    event_time: "2026-11-24T10:00:00+05:30",
    data: {
      dispute: {
        dispute_id: "433475257",
        dispute_type: "CHARGEBACK",
        reason_code: "4855",
        reason_description: "Goods or Services not provided",
        dispute_amount: 199.99,
        created_at: "2026-11-24T09:59:00+05:30",
        updated_at: "2026-11-24T10:00:00+05:30",
        respond_by: "2026-11-27T23:59:00+05:30",
        resolved_at: null,
        dispute_status: "CHARGEBACK_CREATED",
        ...over,
      },
      order_details: { order_id: "gk_abc", cf_payment_id: "__BIG__", payment_amount: 199.99 },
    },
  });
}

describe("settlement state machine", () => {
  it("allows none → RECONCILED → CHARGEBACK and none → CHARGEBACK, nothing else", () => {
    expect(canMoveSettlement(null, "RECONCILED")).toBe(true);
    expect(canMoveSettlement(null, "CHARGEBACK")).toBe(true);
    expect(canMoveSettlement("RECONCILED", "CHARGEBACK")).toBe(true);
    expect(canMoveSettlement("RECONCILED", "RECONCILED")).toBe(false);
    expect(canMoveSettlement("CHARGEBACK", "RECONCILED")).toBe(false);
    expect(canMoveSettlement("CHARGEBACK", "CHARGEBACK")).toBe(false);
  });
});

describe("compareWithGateway", () => {
  const row = { amountPaise: 12_345, gatewayPaymentId: "pay_1" };
  it("confirms the same payment captured for the same amount", () => {
    expect(compareWithGateway(row, state())).toBe("CONFIRMED");
    expect(compareWithGateway({ ...row, gatewayPaymentId: null }, state())).toBe("CONFIRMED");
  });
  it("refuses a different status, amount (by one paisa) or payment id", () => {
    expect(compareWithGateway(row, state({ status: "FAILED" }))).toBe("NOT_CAPTURED");
    expect(compareWithGateway(row, state({ amountPaise: 12_344 }))).toBe("AMOUNT_MISMATCH");
    expect(compareWithGateway(row, state({ gatewayPaymentId: "pay_2" }))).toBe("PAYMENT_MISMATCH");
  });
});

describe("Cashfree dispute webhook", () => {
  it("maps Cashfree's status words to an outcome", () => {
    expect(cashfreeDisputeOutcome("CHARGEBACK_CREATED", "DISPUTE_CREATED")).toBe("OPEN");
    expect(cashfreeDisputeOutcome("DISPUTE_UNDER_REVIEW", "DISPUTE_UPDATED")).toBe("OPEN");
    expect(cashfreeDisputeOutcome("CHARGEBACK_MERCHANT_WON", "DISPUTE_CLOSED")).toBe("WON");
    expect(cashfreeDisputeOutcome("DISPUTE_MERCHANT_LOST", "DISPUTE_CLOSED")).toBe("LOST");
    expect(cashfreeDisputeOutcome("CHARGEBACK_MERCHANT_ACCEPTED", "DISPUTE_UPDATED")).toBe("LOST");
    expect(cashfreeDisputeOutcome("RETRIEVAL_INSUFFICIENT_EVIDENCE", "DISPUTE_CLOSED")).toBe("LOST");
    expect(cashfreeDisputeOutcome("SOMETHING_NEW", "DISPUTE_CLOSED")).toBe("CLOSED");
  });

  it("parses amount (paise), reason, deadline and the exact payment id", () => {
    const event = parseCashfreeDispute(disputeBody(), new Headers())!;
    expect(event.kind).toBe("DISPUTE");
    expect(event.merchantRef).toBe("gk_abc");
    expect(event.gatewayPaymentId).toBe("9007199254740993123");
    expect(event.amountPaise).toBe(19_999);
    expect(event.dispute).toMatchObject({
      disputeId: "433475257",
      disputeType: "CHARGEBACK",
      gatewayStatus: "CHARGEBACK_CREATED",
      outcome: "OPEN",
      amountPaise: 19_999,
      reasonCode: "4855",
      reason: "Goods or Services not provided",
      resolvedAt: null,
    });
    expect(event.dispute!.respondBy!.toISOString()).toBe("2026-11-27T18:29:00.000Z");
    expect(event.eventId).toBe("DISPUTE_CREATED:433475257:CHARGEBACK_CREATED:2026-11-24T04:30:00.000Z");
  });

  it("uses Cashfree's idempotency key as the event id when it sends one", () => {
    const event = parseCashfreeDispute(disputeBody(), new Headers({ "x-idempotency-key": "cf-evt-1" }))!;
    expect(event.eventId).toBe("cf-evt-1");
  });

  it("leaves other events to the payment parser and rejects a dispute without an id", () => {
    expect(parseCashfreeDispute(JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: {} }), new Headers())).toBeNull();
    expect(() => parseCashfreeDispute(disputeBody({ dispute_id: null }), new Headers())).toThrow();
    const payment = new CashfreeGateway().parseWebhook(
      JSON.stringify({ type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id: "gk_1" }, payment: { cf_payment_id: 5, payment_status: "SUCCESS" } } }),
      new Headers(),
    );
    expect(payment.kind).toBe("PAYMENT_CAPTURED");
    expect(new CashfreeGateway().parseWebhook(disputeBody(), new Headers()).kind).toBe("DISPUTE");
  });
});
