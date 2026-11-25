/** docs/guest-checkout-2026-11: order-group payment vs its shop orders (read-only reconciliation). */
import { describe, expect, it } from "vitest";

import { reconcileGroup } from "@/server/guest-checkout/reconciliation";

const intent = (over: Partial<{ status: string; amountPaise: number; refundedPaise: number }> = {}) => ({
  id: "i1",
  status: "CAPTURED",
  amountPaise: 30_000,
  refundedPaise: 0,
  ...over,
});
const child = (orderId: string, totalPaise: number, over: Partial<{ partRefundedPaise: number; gatewayRefundedPaise: number; orderRefundedPaise: number }> = {}) => ({
  orderId,
  totalPaise,
  partRefundedPaise: 0,
  gatewayRefundedPaise: 0,
  orderRefundedPaise: 0,
  ...over,
});

describe("reconcileGroup", () => {
  it("matches when the payment equals the shop orders and refunds agree", () => {
    const r = reconcileGroup({ online: true, intents: [intent()], children: [child("a", 18_000), child("b", 12_000)] });
    expect(r).toMatchObject({ status: "MATCHED", paidPaise: 30_000, childrenTotalPaise: 30_000, differencePaise: 0 });
  });

  it("counts part refunds that lowered a shop order's total (removed items) as charged at checkout", () => {
    const r = reconcileGroup({
      online: true,
      intents: [intent({ status: "PARTIALLY_REFUNDED", refundedPaise: 2_000 })],
      children: [child("a", 16_000, { partRefundedPaise: 2_000, gatewayRefundedPaise: 2_000, orderRefundedPaise: 2_000 }), child("b", 12_000)],
    });
    expect(r).toMatchObject({ status: "MATCHED", childrenTotalPaise: 30_000, refundDifferencePaise: 0, childOrderRefundsPaise: 2_000 });
  });

  it("flags an amount difference and a refund difference", () => {
    expect(reconcileGroup({ online: true, intents: [intent()], children: [child("a", 29_000)] })).toMatchObject({
      status: "AMOUNT_MISMATCH",
      differencePaise: 1_000,
    });
    expect(
      reconcileGroup({ online: true, intents: [intent({ refundedPaise: 5_000 })], children: [child("a", 30_000, { gatewayRefundedPaise: 4_000 })] }),
    ).toMatchObject({ status: "REFUND_MISMATCH", refundDifferencePaise: 1_000 });
  });

  it("ignores failed attempts, flags no payment and two captured payments", () => {
    expect(reconcileGroup({ online: true, intents: [intent({ status: "FAILED" })], children: [child("a", 30_000)] }).status).toBe("NO_PAYMENT");
    expect(reconcileGroup({ online: true, intents: [intent(), { ...intent(), id: "i2" }], children: [child("a", 30_000)] }).status).toBe(
      "DUPLICATE_PAYMENT",
    );
    expect(
      reconcileGroup({ online: true, intents: [intent({ status: "EXPIRED" }), intent()], children: [child("a", 30_000)] }).status,
    ).toBe("MATCHED");
  });

  it("marks a wallet / cash group as not online", () => {
    expect(reconcileGroup({ online: false, intents: [], children: [child("a", 1_000)] }).status).toBe("NOT_ONLINE");
  });
});
