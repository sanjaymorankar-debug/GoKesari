/**
 * batch-2026-10 WS-C — F6.1.3 (NEW-006, D10): cancelling after packing for a
 * fee. Off by default (unchanged D10); on, the customer sees the fee before
 * confirming, the fee is kept from the refund and written to the order
 * ledger, and a shop may set its own fee only within the admin's limits.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as quoteRoute } from "@/app/api/orders/[id]/cancellation-quote/route";
import { POST as cancelRoute } from "@/app/api/orders/[id]/cancel/route";
import { PUT as feeRoute } from "@/app/api/shops/[id]/cancellation-fee/route";
import { db } from "@/server/db";
import {
  financeLedgerEntries,
  financialAdjustments,
  orderCharges,
  orderRefunds,
  orders,
  shopCancellationFeeSettings,
} from "@/server/db/schema";
import { quoteCancellation } from "@/server/aftercare/cancellation";
import { effectiveFeePolicy, feeFor, setShopCancellationFee } from "@/server/aftercare/cancellation-fee";
import { computeRefundBreakdown } from "@/server/aftercare/refunds";
import { cancelOrder } from "@/server/services/orders";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";
import { DELIVERY_FEE, GOODS, START, balanceOf, clearBatchCRules, paidOrderAt, setRuleRaw } from "../helpers/batch-c";

const PAID = GOODS + DELIVERY_FEE;
const signInAs = (u: { id: string; email: string; name: string | null; role: UserRole }) => {
  state.session = { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } };
};
const enableAfterPacking = (extra: Record<string, unknown> = {}) =>
  setRuleRaw("afterPackingCancellation", { enabled: true, defaultFeeType: "FLAT", defaultFeePaise: 2_000, ...extra });

beforeEach(async () => {
  state.session = null;
  await resetDatabase();
  await clearBatchCRules();
});
afterEach(clearBatchCRules);

describe("F6.1.3 flag off — identical to today", () => {
  it("TC-B26-C-001 customer is still blocked at READY and ASSIGNED; nothing changes", async () => {
    for (const status of ["READY", "ASSIGNED"] as const) {
      const s = await paidOrderAt(status);
      await expect(cancelOrder(s.order.id, s.customer, "x", { selfService: true })).rejects.toThrow(/contact the shop/);
      expect((await db.query.orders.findFirst({ where: eq(orders.id, s.order.id) }))!.status).toBe(status);
      expect(await balanceOf(s.customer.id)).toBe(START - PAID);
      const quote = await quoteCancellation(s.order.id, s.customer);
      expect(quote.allowed).toBe(false);
      expect(quote.breakdown.deductions).toHaveLength(0);
      await resetDatabase();
    }
  });

  it("TC-B26-C-002 before packing the quote is a full refund incl. delivery fee and the old path refunds it (no refund row)", async () => {
    const s = await paidOrderAt("CONFIRMED");
    const quote = await quoteCancellation(s.order.id, s.customer);
    expect(quote.allowed).toBe(true);
    expect(quote.breakdown.paidPaise).toBe(PAID);
    expect(quote.breakdown.deductionsPaise).toBe(0);
    expect(quote.breakdown.refundPaise).toBe(PAID);
    expect(quote.refundMethods.map((m) => m.method)).toEqual(["WALLET"]);
    const result = await cancelOrder(s.order.id, s.customer, "Changed my mind", { selfService: true });
    expect(result.status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START);
    expect(await db.select().from(orderRefunds)).toHaveLength(0);
  });

  it("TC-B26-C-003 after dispatch the customer's goods-only refund is unchanged (delivery fee kept), with the rule on as well", async () => {
    await enableAfterPacking();
    const s = await paidOrderAt("OUT_FOR_DELIVERY");
    const quote = await quoteCancellation(s.order.id, s.customer);
    expect(quote.breakdown.deductions.map((d) => d.code)).toEqual(["DELIVERY_FEE_RETAINED"]);
    expect(quote.breakdown.refundPaise).toBe(GOODS);
    await cancelOrder(s.order.id, s.customer, "Too late", { selfService: true });
    expect(await balanceOf(s.customer.id)).toBe(START - DELIVERY_FEE);
    expect(await db.select().from(orderCharges)).toHaveLength(0);
  });
});

describe("F6.1.3 flag on — fee after packing", () => {
  it("TC-B26-C-004 quote before packing has no fee; after packing it shows the platform default fee itemised", async () => {
    await enableAfterPacking();
    const before = await paidOrderAt("CONFIRMED");
    expect((await quoteCancellation(before.order.id, before.customer)).breakdown.deductionsPaise).toBe(0);
    await resetDatabase();
    await enableAfterPacking();
    const after = await paidOrderAt("READY");
    const quote = await quoteCancellation(after.order.id, after.customer);
    expect(quote.allowed).toBe(true);
    expect(quote.breakdown.stage).toBe("AFTER_PACKING");
    expect(quote.breakdown.deductions).toEqual([expect.objectContaining({ code: "AFTER_PACKING_FEE", amountPaise: 2_000 })]);
    expect(quote.breakdown.refundPaise).toBe(PAID - 2_000);
  });

  it("TC-B26-C-005 customer cancels a packed order: fee kept, rest to the wallet, fee in the order ledger and owed to the shop", async () => {
    await enableAfterPacking();
    const s = await paidOrderAt("READY");
    const result = await cancelOrder(s.order.id, s.customer, "Not needed", { selfService: true });
    expect(result.status).toBe("REFUNDED");
    expect(await balanceOf(s.customer.id)).toBe(START - 2_000);

    const [charge] = await db.select().from(orderCharges).where(eq(orderCharges.orderId, s.order.id));
    expect(charge).toMatchObject({ kind: "AFTER_PACKING_CANCELLATION_FEE", amountPaise: 2_000, beneficiary: "SHOP" });
    const ledger = await db.select().from(financeLedgerEntries).where(and(eq(financeLedgerEntries.orderId, s.order.id), eq(financeLedgerEntries.sourceType, "order_charges")));
    expect(ledger.map((l) => `${l.entityType}:${l.direction}:${l.amountPaise}`).sort()).toEqual(
      ["PLATFORM:CREDIT:2000", "PLATFORM:DEBIT:2000", "SHOP:CREDIT:2000"].sort(),
    );
    const [adjustment] = await db.select().from(financialAdjustments).where(eq(financialAdjustments.orderId, s.order.id));
    expect(adjustment).toMatchObject({ type: "SHOP_ADJUSTMENT", party: "SHOP", status: "PENDING", amountPaise: 2_000 });

    const [refund] = await db.select().from(orderRefunds).where(eq(orderRefunds.orderId, s.order.id));
    expect(refund).toMatchObject({ method: "WALLET", status: "SUCCESS", paidPaise: PAID, deductionsPaise: 2_000, amountPaise: PAID - 2_000 });
  });

  it("TC-B26-C-006 a fee kept by the platform is journaled as platform revenue only", async () => {
    await enableAfterPacking({ feeBeneficiary: "PLATFORM" });
    const s = await paidOrderAt("ASSIGNED");
    await cancelOrder(s.order.id, s.customer, "x", { selfService: true });
    const ledger = await db.select().from(financeLedgerEntries).where(eq(financeLedgerEntries.sourceType, "order_charges"));
    expect(ledger.map((l) => `${l.entityType}:${l.direction}`)).toEqual(["PLATFORM:CREDIT"]);
    expect(await db.select().from(financialAdjustments)).toHaveLength(0);
  });

  it("TC-B26-C-007 the shop or support cancelling a packed order still refunds in full (no fee)", async () => {
    await enableAfterPacking();
    const s = await paidOrderAt("READY");
    await cancelOrder(s.order.id, s.owner, "Out of stock");
    expect(await balanceOf(s.customer.id)).toBe(START);
    expect(await db.select().from(orderCharges)).toHaveLength(0);
  });

  it("TC-B26-C-008 a percentage fee is capped, and never more than the admin maximum", async () => {
    await enableAfterPacking({ defaultFeeType: "PERCENT", defaultFeeBp: 1_500, defaultCapPaise: 1_000, maxFeePaise: 10_000 });
    const s = await paidOrderAt("READY");
    // 15% of ₹100 = ₹15, capped at ₹10.
    expect((await computeRefundBreakdown(s.order.id, { selfService: true })).deductionsPaise).toBe(1_000);
    const policy = await effectiveFeePolicy(s.shop.id);
    expect(feeFor({ ...policy, capPaise: 50_000 }, { subtotalPaise: 1_000_000, paidPaise: 1_000_000 }).amountPaise).toBe(50_000);
    expect(feeFor(policy, { subtotalPaise: 500, paidPaise: 300 }).amountPaise).toBe(75);
  });

  it("TC-B26-C-009 the refund amount changing after the quote is refused (409) and nothing moves", async () => {
    await enableAfterPacking();
    const s = await paidOrderAt("READY");
    await expect(
      cancelOrder(s.order.id, s.customer, "x", { selfService: true, refundMethod: "WALLET", expectedRefundPaise: PAID }),
    ).rejects.toThrow(/refund amount has changed/);
    expect(await balanceOf(s.customer.id)).toBe(START - PAID);
    expect((await db.query.orders.findFirst({ where: eq(orders.id, s.order.id) }))!.status).toBe("READY");
  });

  it("TC-B26-C-010 cancelling twice never refunds or charges twice", async () => {
    await enableAfterPacking();
    const s = await paidOrderAt("READY");
    await cancelOrder(s.order.id, s.customer, "x", { selfService: true });
    await expect(cancelOrder(s.order.id, s.customer, "x", { selfService: true })).rejects.toThrow();
    expect(await balanceOf(s.customer.id)).toBe(START - 2_000);
    expect(await db.select().from(orderCharges)).toHaveLength(1);
  });
});

describe("F6.1.3 shop override within the admin's limits", () => {
  it("TC-B26-C-011 a shop's own fee within the limits is saved and used in the quote", async () => {
    await enableAfterPacking({ maxFeePaise: 5_000 });
    const s = await paidOrderAt("READY");
    await setShopCancellationFee(s.shop.id, { enabled: true, feeType: "FLAT", feePaise: 3_000 }, s.owner);
    const quote = await quoteCancellation(s.order.id, s.customer);
    expect(quote.breakdown.deductionsPaise).toBe(3_000);
    await setShopCancellationFee(s.shop.id, { enabled: false, feeType: "FLAT", feePaise: 0 }, s.owner);
    expect((await quoteCancellation(s.order.id, s.customer)).breakdown.deductionsPaise).toBe(0);
  });

  it("TC-B26-C-012 values over the limits are rejected; overrides refused when the admin does not allow them", async () => {
    await enableAfterPacking({ maxFeePaise: 5_000, maxFeeBp: 1_000 });
    const s = await paidOrderAt("READY");
    await expect(setShopCancellationFee(s.shop.id, { enabled: true, feeType: "FLAT", feePaise: 5_001 }, s.owner)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(setShopCancellationFee(s.shop.id, { enabled: true, feeType: "PERCENT", feeBp: 1_001 }, s.owner)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(setShopCancellationFee(s.shop.id, { enabled: true, feeType: "PERCENT", feeBp: 500, capPaise: 9_000 }, s.owner)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await db.select().from(shopCancellationFeeSettings)).toHaveLength(0);
    await enableAfterPacking({ shopOverrideAllowed: false });
    await expect(setShopCancellationFee(s.shop.id, { enabled: true, feeType: "FLAT", feePaise: 100 }, s.owner)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("TC-B26-C-013 a limit lowered later caps an existing shop fee at quote time", async () => {
    await enableAfterPacking({ maxFeePaise: 5_000 });
    const s = await paidOrderAt("READY");
    await setShopCancellationFee(s.shop.id, { enabled: true, feeType: "FLAT", feePaise: 4_000 }, s.owner);
    await enableAfterPacking({ maxFeePaise: 2_500 });
    expect((await quoteCancellation(s.order.id, s.customer)).breakdown.deductionsPaise).toBe(2_500);
  });

  it("TC-B26-C-014 another shop's owner cannot set this shop's fee (route 403); the owner can (route 200)", async () => {
    await enableAfterPacking();
    const s = await paidOrderAt("READY");
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    await createShop(otherOwner.id);
    signInAs({ ...otherOwner, role: "SHOP_OWNER" });
    const denied = await call(feeRoute, `/api/shops/${s.shop.id}/cancellation-fee`, { method: "PUT", params: { id: s.shop.id }, body: { enabled: true, feeType: "FLAT", feePaise: 100 } });
    expect(denied.status).toBe(403);
    signInAs(s.owner);
    const allowed = await call(feeRoute, `/api/shops/${s.shop.id}/cancellation-fee`, { method: "PUT", params: { id: s.shop.id }, body: { enabled: true, feeType: "FLAT", feePaise: 100 } });
    expect(allowed.status).toBe(200);
    const over = await call(feeRoute, `/api/shops/${s.shop.id}/cancellation-fee`, { method: "PUT", params: { id: s.shop.id }, body: { enabled: true, feeType: "FLAT", feePaise: 999_999 } });
    expect(over.status).toBe(422);
  });
});

describe("F6.1.3 quote and cancel routes", () => {
  it("TC-B26-C-015 the quote route serves the buyer, refuses a stranger (404), and the cancel route uses the customer's confirmation", async () => {
    await enableAfterPacking();
    const s = await paidOrderAt("READY");
    const stranger = await createUser();
    signInAs({ ...stranger, role: "CUSTOMER" });
    expect((await call(quoteRoute, `/api/orders/${s.order.id}/cancellation-quote`, { params: { id: s.order.id } })).status).toBe(404);
    signInAs(s.customer);
    const quote = await call(quoteRoute, `/api/orders/${s.order.id}/cancellation-quote`, { params: { id: s.order.id } });
    expect(quote.status).toBe(200);
    expect(quote.body.breakdown.refundPaise).toBe(PAID - 2_000);
    const cancelled = await call(cancelRoute, `/api/orders/${s.order.id}/cancel`, {
      method: "POST",
      params: { id: s.order.id },
      body: { refundMethod: "WALLET", expectedRefundPaise: quote.body.breakdown.refundPaise },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order.status).toBe("REFUNDED");
    expect(cancelled.body.refund).toMatchObject({ method: "WALLET", status: "SUCCESS", amountPaise: PAID - 2_000 });
  });
});
