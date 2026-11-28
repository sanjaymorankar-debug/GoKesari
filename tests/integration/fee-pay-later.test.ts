/**
 * Registration fee "Pay later" (0229; owner request 28-Nov-2026; docs/fee-pay-later-2026-11). Real PostgreSQL.
 *   - the owner asks, administrators are told; only an administrator decides; reject needs a reason
 *   - approve: a live shop stays live; a pending shop goes live (the fee no longer holds it)
 *   - payout cycle: the whole fee when the payout is larger, all of the payout when smaller; ledger + statement
 *   - weekly settlement: the same deduction off the net payable
 *   - paying online ends the request; weekly reminder schedule; flag off hides the choice
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return { ...actual, emailMode: () => "smtp" as const, sendEmail: vi.fn(async () => {}) };
});

import { db } from "@/server/db";
import { notifications, payoutCycleLines, payoutItems, shopFeePayLater, shopFeeRecoveries, shopPayments, shops, shopSettlements } from "@/server/db/schema";
import { closePayoutCycle } from "@/server/payouts/cycle";
import {
  decidePayLater,
  feeDeferredByApproval,
  payLaterStatement,
  recoveryFrom,
  requestShopFeePayLater,
} from "@/server/services/fee-pay-later";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { prepareShopSettlements, previousWeekStart, setCommissionRate } from "@/server/services/finance";
import { recordPayment } from "@/server/services/shop-payments";
import { payLaterReminderPlan } from "@/server/services/shop-registration-subscription";
import { addDaysIso, deliveredOrder, gstShop, IST_TODAY, resetBatchE, rules, verifiedBank } from "../helpers/batch-e";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };
const today = IST_TODAY();
const anchor = addDaysIso(today, -10);

async function flag(enabled: boolean) {
  await setFeatureFlag("shop_fee_pay_later_enabled", { enabled, districtCodes: null }, "pay-later integration test", admin);
  clearFeatureFlagCache();
}

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
  await rules(admin, { invoicing: { enabled: true }, payouts: { enabled: true, anchorDate: anchor, cycleDays: 5, holdDays: 0, provider: "SANDBOX", minPayoutPaise: 100 } });
  await flag(true);
});

afterAll(async () => {
  await resetBatchE();
});

/** A live GST shop with a verified bank account, one delivered order (4 L × ₹105) and a registration fee of `feePaise`. */
async function liveShopWithSale(feePaise: number) {
  const s = await gstShop();
  await db.update(shops).set({ registrationFeePaise: feePaise, feePaymentStatus: "PENDING", amountPaidPaise: 0 }).where(eq(shops.id, s.shop.id));
  await verifiedBank(s.owner.id, s.shop.id);
  await deliveredOrder(admin, [[s.milkSp.id, 4]], { deliveredDaysAgo: 3 });
  return s;
}

async function shopRow(id: string) {
  return (await db.select().from(shops).where(eq(shops.id, id)))[0];
}

describe("request and decision", () => {
  it("PL-01 the owner asks, administrators are told; asking again returns the same request", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: 118_000 });
    const first = await requestShopFeePayLater(shop.id, { id: owner.id }, "Season is slow, will pay from sales");
    expect(first).toMatchObject({ status: "REQUESTED", amountPaise: 118_000, shopId: shop.id, ownerNote: "Season is slow, will pay from sales" });
    const again = await requestShopFeePayLater(shop.id, { id: owner.id });
    expect(again.id).toBe(first.id);
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, admin.id), eq(notifications.type, "support.shop_fee_pay_later_requested")));
    expect(told).toHaveLength(1);
    // Another owner's shop is not even confirmed to exist.
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(requestShopFeePayLater(shop.id, { id: stranger.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("PL-02 only an administrator decides; a rejection needs a reason the owner sees", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: 118_000 });
    const req = await requestShopFeePayLater(shop.id, { id: owner.id });
    const operator = await createUser({ role: "OPERATOR" });
    await expect(decidePayLater(req.id, "APPROVE", null, { id: operator.id, role: "OPERATOR" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decidePayLater(req.id, "REJECT", "  ", admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const rejected = await decidePayLater(req.id, "REJECT", "Please pay within 7 days", admin);
    expect(rejected.request).toMatchObject({ status: "REJECTED", decisionNote: "Please pay within 7 days", decidedBy: admin.id });
    const [notice] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.fee_pay_later")));
    expect(notice.body).toContain("Please pay within 7 days");
    await expect(decidePayLater(req.id, "APPROVE", null, admin)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("PL-03 approving a pending shop puts it live — the fee no longer holds it back", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "PENDING_APPROVAL", registrationFeePaise: 118_000 });
    await verifySellerDocuments(shop.id);
    const req = await requestShopFeePayLater(shop.id, { id: owner.id });
    expect(await feeDeferredByApproval(shop.id)).toBe(false);
    const result = await decidePayLater(req.id, "APPROVE", null, admin);
    expect(result.waitingFor).toBeNull();
    expect(result.live).toBe(true);
    const after = await shopRow(shop.id);
    expect(after.status).toBe("APPROVED");
    expect(after.feePaymentStatus).toBe("PENDING");
    expect(await feeDeferredByApproval(shop.id)).toBe(true);
  });

  it("PL-04 with the flag off the owner cannot ask", async () => {
    await flag(false);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: 118_000 });
    await expect(requestShopFeePayLater(shop.id, { id: owner.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("recovery from payouts", () => {
  it("PL-10 payout smaller than the fee: all of the payout goes to the fee, the rest stays owed", async () => {
    const s = await liveShopWithSale(500_000);
    const req = await requestShopFeePayLater(s.shop.id, { id: s.owner.id });
    await decidePayLater(req.id, "APPROVE", null, admin);

    const closed = await closePayoutCycle({ today, actor: admin });
    const lines = await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.shopId, s.shop.id));
    const recovery = lines.find((l) => l.lineType === "REGISTRATION_FEE_RECOVERY")!;
    expect(recovery).toBeDefined();
    const before = lines.filter((l) => l.lineType !== "REGISTRATION_FEE_RECOVERY").reduce((sum, l) => sum + l.amountPaise, 0);
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(500_000);
    expect(recovery.amountPaise).toBe(-before);
    const [item] = await db.select().from(payoutItems).where(eq(payoutItems.shopId, s.shop.id));
    expect(item.amountPaise).toBe(0);
    expect(closed!.cycle.id).toBe(item.cycleId);

    // On the shop's fee ledger, as a payment taken from the payout.
    const [pay] = await db.select().from(shopPayments).where(eq(shopPayments.shopId, s.shop.id));
    expect(pay).toMatchObject({ paymentType: "REGISTRATION_FEE", method: "PAYOUT_DEDUCTION", amountPaise: before });
    const shop = await shopRow(s.shop.id);
    expect(shop).toMatchObject({ amountPaidPaise: before, feePaymentStatus: "PARTIALLY_PAID" });
    const [still] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.id, req.id));
    expect(still.status).toBe("APPROVED");

    // The owner's statement: fee, deduction, what is left, GoKesari's commission so far.
    const st = await payLaterStatement(shop);
    expect(st).toMatchObject({ feePaise: 500_000, recoveredPaise: before, duePaise: 500_000 - before, deliveredOrders: 1, commissionEarnedPaise: 4_200 });
    expect(st.deductions).toHaveLength(1);
    expect(st.deductions[0]).toMatchObject({ amountPaise: before, payoutBeforePaise: before, source: "PAYOUT_CYCLE" });
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, s.owner.id), eq(notifications.type, "shop.fee_pay_later")));
    expect(told.some((n) => n.body.includes("Still to pay"))).toBe(true);

    // Closing the same cycle again takes nothing more.
    await closePayoutCycle({ today, actor: admin });
    expect(await db.select().from(shopFeeRecoveries).where(eq(shopFeeRecoveries.shopId, s.shop.id))).toHaveLength(1);
  });

  it("PL-11 payout larger than the fee: the whole fee is taken, the rest is paid out and the request ends", async () => {
    const s = await liveShopWithSale(10_000); // ₹100 fee
    const req = await requestShopFeePayLater(s.shop.id, { id: s.owner.id });
    await decidePayLater(req.id, "APPROVE", null, admin);
    await closePayoutCycle({ today, actor: admin });
    const lines = await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.shopId, s.shop.id));
    const recovery = lines.find((l) => l.lineType === "REGISTRATION_FEE_RECOVERY")!;
    expect(recovery.amountPaise).toBe(-10_000);
    const before = lines.filter((l) => l.lineType !== "REGISTRATION_FEE_RECOVERY").reduce((sum, l) => sum + l.amountPaise, 0);
    const [item] = await db.select().from(payoutItems).where(eq(payoutItems.shopId, s.shop.id));
    expect(item.amountPaise).toBe(before - 10_000);
    expect(await shopRow(s.shop.id)).toMatchObject({ amountPaidPaise: 10_000, feePaymentStatus: "PAID" });
    const [done] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.id, req.id));
    expect(done.status).toBe("SETTLED");
    expect(done.settledAt).not.toBeNull();
  });

  it("PL-12 no approved request: nothing is taken from the payout", async () => {
    const s = await liveShopWithSale(500_000);
    await requestShopFeePayLater(s.shop.id, { id: s.owner.id }); // asked, not yet approved
    await closePayoutCycle({ today, actor: admin });
    const lines = await db.select().from(payoutCycleLines).where(eq(payoutCycleLines.shopId, s.shop.id));
    expect(lines.some((l) => l.lineType === "REGISTRATION_FEE_RECOVERY")).toBe(false);
    expect(await db.select().from(shopPayments).where(eq(shopPayments.shopId, s.shop.id))).toHaveLength(0);
  });

  it("PL-13 weekly settlement (automated payouts off): the deduction comes off the net payable", async () => {
    await rules(admin, { payouts: { enabled: false } });
    const s = await liveShopWithSale(10_000);
    const req = await requestShopFeePayLater(s.shop.id, { id: s.owner.id });
    await decidePayLater(req.id, "APPROVE", null, admin);
    await db.execute(sql`UPDATE order_financials SET delivered_at = now() - interval '9 days'`);
    const settlements = await prepareShopSettlements(previousWeekStart(), { id: admin.id, role: "ADMIN" });
    const mine = settlements.find((x) => x.shopId === s.shop.id)!;
    const gross = mine.goodsPaise - mine.commissionPaise + mine.refundsPaise;
    expect(mine.adjustmentsPaise).toBe(-10_000);
    expect(mine.netPayablePaise).toBe(gross - 10_000);
    const [rec] = await db.select().from(shopFeeRecoveries).where(eq(shopFeeRecoveries.shopId, s.shop.id));
    expect(rec).toMatchObject({ sourceType: "SHOP_SETTLEMENT", sourceId: mine.id, amountPaise: 10_000, payoutBeforePaise: gross });
    expect(await shopRow(s.shop.id)).toMatchObject({ feePaymentStatus: "PAID" });
    expect((await db.select().from(shopSettlements)).length).toBe(1);
  });

  it("PL-14 paying the fee another way ends the request (no further deductions)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "APPROVED", registrationFeePaise: 118_000 });
    const req = await requestShopFeePayLater(shop.id, { id: owner.id });
    await decidePayLater(req.id, "APPROVE", null, admin);
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 118_000, method: "UPI", transactionId: "UPI-PL-14" }, admin);
    const [done] = await db.select().from(shopFeePayLater).where(eq(shopFeePayLater.id, req.id));
    expect(done.status).toBe("SETTLED");
    expect(await feeDeferredByApproval(shop.id)).toBe(false);
  });
});

describe("pure rules", () => {
  it("PL-20 recoveryFrom: all of the fee, or all of the payout when smaller; never from a zero or negative payout", () => {
    expect(recoveryFrom(30_000, 118_000)).toBe(30_000);
    expect(recoveryFrom(200_000, 118_000)).toBe(118_000);
    expect(recoveryFrom(0, 118_000)).toBe(0);
    expect(recoveryFrom(-5_000, 118_000)).toBe(0);
    expect(recoveryFrom(50_000, 0)).toBe(0);
  });

  it("PL-21 the reminder goes every 7 days from the approval", () => {
    expect(payLaterReminderPlan("2026-11-28", "2026-11-28")).toBeNull();
    expect(payLaterReminderPlan("2026-11-28", "2026-12-04")).toBeNull();
    expect(payLaterReminderPlan("2026-11-28", "2026-12-05")).toEqual({ kind: "UNPAID", stage: "PL1" });
    expect(payLaterReminderPlan("2026-11-28", "2026-12-12")).toEqual({ kind: "UNPAID", stage: "PL2" });
    expect(payLaterReminderPlan("2026-11-28", "2026-12-13")).toBeNull();
  });
});
