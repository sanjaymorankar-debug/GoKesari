/**
 * Territory dealers (owner, 20 Nov 2026; docs/dealer-programme/TERRITORY_DEALER.md), against real PostgreSQL:
 *   - an admin gives a TIERED dealer an exclusive territory (pincodes no other territory holds)
 *   - the yearly fee: recorded offline or paid online (capture handler), 12 months each, renewal from the paid-up date
 *   - the daily job: rating (onboarding + product upload) and share, expiry, release after the grace days
 *   - the month close: the share of GoKesari's commission on each order delivered in the territory while paid
 *     up (net of refunds), one TERRITORY entry, paid with the dealer's payout; a later refund taken back
 *   - rule off: nothing can be given and nothing is worked out
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { db } from "@/server/db";
import {
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerExclusiveTerritories,
  dealerPayoutBatches,
  dealerTerritoryFees,
  dealerTerritoryOrderShares,
  dealerTerritoryPincodes,
  dealerTerritoryRatings,
  dealers,
  financialAdjustments,
  orderFinancials,
  orders,
} from "@/server/db/schema";
import { setCommissionSettings } from "@/server/dealers/commission";
import { closeCommissionMonth, dealerMonthStatement } from "@/server/dealers/monthly-payout";
import {
  cancelTerritory,
  changeTerritoryPincodes,
  createTerritory,
  istDay,
  onTerritoryFeeCaptured,
  rateTerritory,
  recordOfflineFee,
  runTerritoryDaily,
  setTerritoryFee,
  territoryViews,
} from "@/server/dealers/territory";
import { setDealerCommissionModel } from "@/server/dealers/tiered";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setCommissionRate } from "@/server/services/finance";
import { updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { RULES } from "@/server/config/rules";
import { createCategory, createOrder, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };
const DAY = 86_400_000;

async function territoryRule(over: Partial<(typeof RULES)["territoryDealer"]["defaults"]> = {}) {
  await setRule("territoryDealer", { ...RULES.territoryDealer.defaults, enabled: true, liveMinProducts: 1, ...over }, admin);
  clearRuleCache();
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionSettings(
    { catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, autoApproveAtMonthEnd: true, payoutDayOfMonth: 5 },
    "test defaults",
    admin,
  );
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", admin);
  for (const key of ["dealerTieredCommission", "territoryDealer", "dealerPayouts", "dealerPayoutTds"]) await db.execute(sql`delete from platform_settings where key = ${key}`);
  await setRule("dealerTieredCommission", { ...RULES.dealerTieredCommission.defaults, enabled: true }, admin);
  await territoryRule();
  // GoKesari's commission on every order: 2%.
  await setCommissionRate({ scope: "DEFAULT", rateBp: 200 }, admin);
});

/** An approved TIERED dealer with PAN and a verified bank, who accepted the agent agreement. */
async function tieredDealer(name = "Kothrud Network") {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: name, contactName: "Owner", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", tierAgreementVersion: AGENT_AGREEMENT_VERSION, tierAgreementAcceptedAt: new Date() })
    .returning();
  await setDealerCommissionModel(dealer.id, "TIERED", "territory pilot (test)", admin);
  return { ...dealer, user };
}

/** An approved shop in `pincode` with `products` active products. */
async function liveShop(pincode: string, products = 1) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: `Shop ${pincode} ${Math.random().toString(36).slice(2, 6)}`, status: "APPROVED" });
  await db.execute(sql`update shops set pincode = ${pincode} where id = ${shop.id}`);
  const category = products ? await createCategory({ name: `Cat ${Math.random().toString(36).slice(2, 6)}` }) : null;
  for (let i = 0; i < products; i++) {
    const product = await createProduct(category!.id, { name: `Item ${i} ${Math.random().toString(36).slice(2, 6)}` });
    await createShopProduct(shop.id, product.id, { isActive: true });
  }
  return shop;
}

/** A paid order of `subtotal` paise delivered now (the finance snapshot takes GoKesari's 2%). */
async function deliveredOrder(shopId: string, subtotal = 100_000) {
  const buyer = await createUser();
  const order = await createOrder(buyer.id, shopId, { status: "OUT_FOR_DELIVERY", subtotalPaise: subtotal, paidAt: new Date() });
  await db.update(orders).set({ deliveryAddressSnapshot: { line1: "1 Buyer Road", city: "Pune", pincode: "411038" } }).where(eq(orders.id, order.id));
  await updateOrderStatus(order.id, "DELIVERED", admin);
  const [fin] = await db.select().from(orderFinancials).where(eq(orderFinancials.orderId, order.id));
  return { order, fin };
}

function thisMonth() {
  return istDay(new Date()).slice(0, 7);
}
function monthAfter(month: string) {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}
/** Closes `month` as on the 2nd of the month after. */
async function close(month: string) {
  const next = monthAfter(month);
  return closeCommissionMonth(month, admin, new Date(`${next}-02T06:00:00+05:30`));
}

function capture(feeId: string, amountPaise: number, id = crypto.randomUUID()): PaymentIntentRef {
  return { id, purpose: "TERRITORY_FEE", referenceId: feeId, userId: null, amountPaise, refundedPaise: 0, status: "CAPTURED", gateway: "MOCK", gatewayOrderId: null } as unknown as PaymentIntentRef;
}

describe("giving a territory: exclusive pincodes", () => {
  it("only a TIERED dealer, only an admin, and a pincode is held by one territory at a time", async () => {
    const d1 = await tieredDealer("Kothrud Network");
    const d2 = await tieredDealer("Baner Network");
    await expect(createTerritory({ dealerId: d1.id, name: "Kothrud", pincodes: ["411038"], feePaise: 5_000_000 }, { id: admin.id, role: "OPERATOR" as never })).rejects.toThrow(/admin/i);
    const t = await createTerritory({ dealerId: d1.id, name: "Kothrud", pincodes: ["411038", "411029", "411038"], feePaise: 5_000_000 }, admin);
    expect(t).toMatchObject({ status: "AWAITING_FEE", feePaise: 5_000_000 });
    expect((await db.select().from(dealerTerritoryPincodes).where(eq(dealerTerritoryPincodes.territoryId, t.id))).map((p) => p.pincode).sort()).toEqual(["411029", "411038"]);
    expect(await db.select().from(dealerTerritoryFees).where(eq(dealerTerritoryFees.territoryId, t.id))).toEqual([expect.objectContaining({ status: "AWAITING_PAYMENT", amountPaise: 5_000_000 })]);

    await expect(createTerritory({ dealerId: d2.id, name: "Baner", pincodes: ["411045", "411038"], feePaise: 4_000_000 }, admin)).rejects.toThrow(/411038 \(Kothrud Network, Kothrud\)/);
    // The database refuses it too.
    const t2 = await createTerritory({ dealerId: d2.id, name: "Baner", pincodes: ["411045"], feePaise: 4_000_000 }, admin);
    await expect(db.insert(dealerTerritoryPincodes).values({ territoryId: t2.id, pincode: "411029" })).rejects.toThrow();

    // A STANDARD dealer cannot hold one.
    const d3 = await tieredDealer("Plain Dealer");
    await setDealerCommissionModel(d3.id, "STANDARD", "back to standard (test)", admin);
    await expect(createTerritory({ dealerId: d3.id, name: "Aundh", pincodes: ["411007"], feePaise: 100_000 }, admin)).rejects.toThrow(/TIERED/);

    // Released pincodes can be given to another territory.
    await changeTerritoryPincodes(t.id, { add: [], remove: ["411029"], reason: "dealer asked (test)" }, admin);
    await expect(changeTerritoryPincodes(t2.id, { add: ["411029"], remove: [], reason: "now free (test)" }, admin)).resolves.toEqual({ added: ["411029"], removed: [] });
    await cancelTerritory(t.id, "dealer left (test)", admin);
    await expect(createTerritory({ dealerId: d2.id, name: "Kothrud again", pincodes: ["411038"], feePaise: 100_000 }, admin)).resolves.toMatchObject({ status: "AWAITING_FEE" });
  });

  it("rule off: nothing can be given", async () => {
    const d = await tieredDealer();
    await territoryRule({ enabled: false });
    await expect(createTerritory({ dealerId: d.id, name: "Kothrud", pincodes: ["411038"], feePaise: 100_000 }, admin)).rejects.toThrow(/switched off/);
  });
});

describe("the yearly fee", () => {
  it("recorded offline: active for 12 months; a renewal paid early runs on from the paid-up date", async () => {
    const d = await tieredDealer();
    const t = await createTerritory({ dealerId: d.id, name: "Kothrud", pincodes: ["411038"], feePaise: 5_000_000 }, admin);
    const before = Date.now();
    const paid = await recordOfflineFee(t.id, { reference: "UTR123456" }, admin);
    expect(paid.status).toBe("ACTIVE");
    const until = paid.paidUntil!.getTime();
    expect(until - before).toBeGreaterThan(360 * DAY);
    expect(until - before).toBeLessThan(370 * DAY);
    // Renewal (fee changed meanwhile): runs from the paid-up date, not from today.
    await setTerritoryFee(t.id, 6_000_000, "new year's price (test)", admin);
    const renewed = await recordOfflineFee(t.id, { reference: "UTR999" }, admin);
    expect(renewed.paidUntil!.getTime() - until).toBeGreaterThan(360 * DAY);
    const fees = await db.select().from(dealerTerritoryFees).where(eq(dealerTerritoryFees.territoryId, t.id));
    expect(fees.map((f) => [f.status, f.method, f.amountPaise]).sort()).toEqual([
      ["PAID", "OFFLINE", 5_000_000],
      ["PAID", "OFFLINE", 6_000_000],
    ]);
  });

  it("paid online: the capture pays it up once; a wrong amount does not", async () => {
    const d = await tieredDealer();
    const t = await createTerritory({ dealerId: d.id, name: "Kothrud", pincodes: ["411038"], feePaise: 5_000_000 }, admin);
    const [fee] = await db.select().from(dealerTerritoryFees).where(eq(dealerTerritoryFees.territoryId, t.id));
    await onTerritoryFeeCaptured(capture(fee.id, 4_999_900), db);
    expect((await db.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, t.id)))[0].status).toBe("AWAITING_FEE");
    const intentId = crypto.randomUUID();
    await onTerritoryFeeCaptured(capture(fee.id, 5_000_000, intentId), db);
    await onTerritoryFeeCaptured(capture(fee.id, 5_000_000, intentId), db); // the webhook again
    const [after] = await db.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, t.id));
    expect(after.status).toBe("ACTIVE");
    expect(await db.select().from(dealerTerritoryFees).where(eq(dealerTerritoryFees.territoryId, t.id))).toEqual([expect.objectContaining({ status: "PAID", method: "ONLINE", paymentIntentId: intentId })]);
  });
});

describe("the daily job: rating, expiry and release", () => {
  it("rates on onboarding and product upload; expires when unpaid; releases the pincodes after the grace days", async () => {
    const d = await tieredDealer();
    await db.update(dealers).set({ rating: 9 }).where(eq(dealers.id, d.id));
    const t = await createTerritory({ dealerId: d.id, name: "Kothrud", pincodes: ["411038", "411029"], feePaise: 5_000_000 }, admin);
    await recordOfflineFee(t.id, { reference: "UTR1" }, admin);
    await liveShop("411038", 2);
    await liveShop("411038", 1);
    await liveShop("411029", 0); // no products: not live
    await liveShop("411001", 3); // outside the territory
    // Onboarding (9 − 5)/5 × 2.5 = 2.0; product 2 of 3 live × 2.5 = 1.7 → 8.7 → 23.7%
    const now = new Date();
    const r = await runTerritoryDaily(now);
    expect(r).toMatchObject({ rated: 1, expired: 0 });
    const [row] = await db.select().from(dealerTerritoryRatings).where(eq(dealerTerritoryRatings.territoryId, t.id));
    expect(row).toMatchObject({ day: istDay(now), shopsTotal: 3, shopsLive: 2, onboardingPoints: 2, productPoints: 1.7, rating: 8.7, shareBp: 2370 });
    expect((await territoryViews(d.id))[0]).toMatchObject({ rating: 8.7, shareBp: 2370, pincodes: ["411029", "411038"] });

    // A year and a day later, unpaid: expired, a fee to pay, the pincodes still his.
    const [paid] = await db.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, t.id));
    const later = new Date(paid.paidUntil!.getTime() + DAY);
    expect(await runTerritoryDaily(later)).toMatchObject({ expired: 1 });
    const [expired] = await db.select().from(dealerExclusiveTerritories).where(eq(dealerExclusiveTerritories.id, t.id));
    expect(expired.status).toBe("EXPIRED");
    expect((await territoryViews(d.id, later))[0]).toMatchObject({ canPay: true, openFee: { amountPaise: 5_000_000 } });
    // 31 days after it lapsed: released.
    expect(await runTerritoryDaily(new Date(paid.paidUntil!.getTime() + 31 * DAY))).toMatchObject({ released: 1 });
    expect((await territoryViews(d.id))[0]).toMatchObject({ pincodes: [], canPay: false });
    await expect(recordOfflineFee(t.id, { reference: "late" }, admin)).rejects.toThrow(/released/);
  });
});

describe("order income at the month close", () => {
  it("pays the share of GoKesari's 2% on orders in the territory while paid up, net of refunds, with the payout", async () => {
    const d = await tieredDealer();
    const t = await createTerritory({ dealerId: d.id, name: "Kothrud", pincodes: ["411038"], feePaise: 5_000_000 }, admin);
    const inside = await liveShop("411038", 1);
    const outside = await liveShop("411001", 1);
    // Delivered before the fee was paid: not counted.
    await deliveredOrder(inside.id, 50_000);
    await recordOfflineFee(t.id, { reference: "UTR1" }, admin);
    // Dealer rating 5, 1 of 1 shops live → 5 + 0 + 2.5 = 7.5 → 22.5%.
    expect(await rateTerritory(t.id)).toEqual({ rating: 7.5, shareBp: 2250 });
    const a = await deliveredOrder(inside.id, 100_000); // ₹1,000 → ₹20 commission → ₹4.50
    const b = await deliveredOrder(inside.id, 200_000); // ₹2,000 → ₹40 commission
    await deliveredOrder(outside.id, 100_000); // not his pincode
    expect(a.fin.commissionPaise).toBe(2_000);
    // Half of order b refunded before the close: commission on ₹1,000 of goods (₹20) comes off.
    await db.insert(financialAdjustments).values({ type: "REFUND_SHOP", party: "SHOP", status: "PENDING", shopId: inside.id, orderId: b.order.id, amountPaise: -98_000, customerRefundPaise: 100_000, reason: "half refunded (test)", idempotencyKey: `test-refund-${b.order.id}` });

    // Live view before the close: 2 orders, ₹40 kept, ₹9.00.
    expect((await territoryViews(d.id))[0].monthSoFar).toEqual({ orders: 2, commissionKeptPaise: 4_000, incomePaise: 900 });

    const month = thisMonth();
    const result = await close(month);
    const [entry] = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.entryType, "TERRITORY"));
    expect(entry).toMatchObject({ dealerId: d.id, payeeMemberId: null, shopId: null, kind: "ACCRUAL", milestone: "MONTHLY", basePaise: 4_000, amountPaise: 900, bonusBp: 2250, accrualKey: `TO:${t.id}:${month}` });
    expect(entry.status === "APPROVED" || entry.status === "PAID").toBe(true);
    const shares = await db.select().from(dealerTerritoryOrderShares);
    expect(shares.map((s) => [s.orderId, s.commissionPaise, s.refundedCommissionPaise, s.shareBp, s.amountPaise]).sort()).toEqual(
      [
        [a.order.id, 2_000, 0, 2250, 450],
        [b.order.id, 4_000, 2_000, 2250, 450],
      ].sort(),
    );
    // Paid with the dealer's payout, and on his statement as its own line.
    const batch = result.payouts.find((p) => p.dealerId === d.id && p.memberId === null);
    expect(batch?.totalPaise).toBe(900);
    const statement = await dealerMonthStatement(d.id, month);
    expect(statement.lines).toEqual(expect.arrayContaining([expect.objectContaining({ key: "territory", amountPaise: 900 })]));

    // The rest of order a refunded after the close: taken back at the next close.
    await db.insert(financialAdjustments).values({ type: "REFUND_PLATFORM", party: "PLATFORM", status: "RECORDED", shopId: inside.id, orderId: a.order.id, amountPaise: 0, customerRefundPaise: 100_000, reason: "refunded after close (test)", idempotencyKey: `test-refund-${a.order.id}` });
    const next = monthAfter(month);
    await close(next);
    const reversals = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.kind, "REVERSAL"));
    expect(reversals).toEqual([expect.objectContaining({ entryType: "TERRITORY", amountPaise: -450, reversesId: entry.id, status: "EARNED" })]);
    expect((await db.select().from(dealerTerritoryOrderShares).where(eq(dealerTerritoryOrderShares.orderId, a.order.id)))[0]).toMatchObject({ refundedCommissionPaise: 2_000, amountPaise: 0 });
    // Owed back: carried to the next payout, not paid.
    expect(await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.dealerId, d.id))).toHaveLength(1);
  });

  it("an order delivered before the first rating earns the base 20%; a day's rating applies to that day's orders", async () => {
    const d = await tieredDealer();
    const t = await createTerritory({ dealerId: d.id, name: "Kothrud", pincodes: ["411038"], feePaise: 100_000 }, admin);
    await recordOfflineFee(t.id, { reference: "UTR1" }, admin);
    const shop = await liveShop("411038", 0);
    const before = await deliveredOrder(shop.id, 100_000); // no rating at all → 20%: ₹4.00
    // Back-date it before a rating row dated today, so a later day's rating cannot reach it.
    await db.execute(sql`update order_financials set delivered_at = delivered_at - interval '1 day' where order_id = ${before.order.id}`);
    await db.insert(dealerTerritoryRatings).values({ territoryId: t.id, day: istDay(new Date()), onboardingRating: 10, shopsTotal: 1, shopsLive: 1, onboardingPoints: 2.5, productPoints: 2.5, rating: 10, shareBp: 2500 });
    const today = await deliveredOrder(shop.id, 100_000); // today's row → 25%: ₹5.00
    const month = thisMonth();
    const yesterdayMonth = istDay(new Date(Date.now() - DAY)).slice(0, 7);
    if (yesterdayMonth !== month) return; // the 1st of a month: yesterday's order belongs to the month before
    // The fee and the pincodes date from "now": back-date both to cover yesterday's delivery too.
    await db.execute(sql`update dealer_territory_fees set period_start = period_start - interval '2 days' where territory_id = ${t.id}`);
    await db.execute(sql`update dealer_territory_pincodes set held_from = held_from - interval '2 days' where territory_id = ${t.id}`);
    await close(month);
    const shares = await db.select().from(dealerTerritoryOrderShares);
    expect(shares.map((s) => [s.orderId, s.shareBp, s.amountPaise]).sort()).toEqual(
      [
        [before.order.id, 2000, 400],
        [today.order.id, 2500, 500],
      ].sort(),
    );
  });

  it("rule off: no order income is worked out", async () => {
    const d = await tieredDealer();
    const t = await createTerritory({ dealerId: d.id, name: "Kothrud", pincodes: ["411038"], feePaise: 100_000 }, admin);
    await recordOfflineFee(t.id, { reference: "UTR1" }, admin);
    const shop = await liveShop("411038", 1);
    await deliveredOrder(shop.id, 100_000);
    await territoryRule({ enabled: false });
    await close(thisMonth());
    expect(await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.entryType, "TERRITORY"))).toHaveLength(0);
    expect(await db.select().from(dealerTerritoryOrderShares)).toHaveLength(0);
  });
});
