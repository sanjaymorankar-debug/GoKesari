/**
 * Flow spec v3, wave 4 (docs/flows-v3/wave4.md) against real PostgreSQL, each item with its flag ON and OFF:
 *   F7  live shop for every paid booking; plan franchisee renews without PAN, for the plan's term
 *   F21 one hold per dealer; the hold really ends at 15 min + grace; late payment: slot free → confirmed, other slot
 *       taken, slot lost → automatic refund (full / pro rata) through the sandbox gateway; "on hold" count
 *   F10 the tail ends at most 3 years after the first start (renewals included); free dealer 12-month validity
 *   F9  own shops in any area; the zone's first franchise keeps the others (no 50/50); second buyer inherits nobody's
 *   F8  downgrading a team lead moves his agents
 *   F12 customer code made when the account's codes are listed
 *   F22 commission held 3 days; GST + invoice for a GST-registered dealer; statement lines; clawback on a fee refund
 * Payments run on the in-process sandbox gateway only (never a live gateway).
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { FRANCHISE_AGREEMENT_VERSION, allocationExpiry, renewedExpiry } from "@/lib/franchise";
import { db } from "@/server/db";
import {
  customerReferralCodes,
  dealerCommissionInvoiceCounters,
  dealerCommissionInvoices,
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerPayoutBatches,
  dealerSalespeople,
  dealers,
  franchiseAllocations,
  franchiseAreas,
  franchiseBookings,
  franchiseCalcRuns,
  franchiseCampaigns,
  franchiseConfigVersions,
  franchiseMonthlySnapshots,
  franchiseNotificationLog,
  franchisePlans,
  franchiseShopAttributions,
  franchiseShopTeamPeriods,
  franchiseZones,
  orders,
  paymentIntents,
  paymentRefunds,
  sellerVerifications,
  shopAttributions,
  shops,
  type DealerSalesperson,
  type FeatureFlagKey,
} from "@/server/db/schema";
import { setCommissionSettings } from "@/server/dealers/commission";
import { closeCommissionMonth, dealerMonthStatement, monthBounds, monthStatementCsv } from "@/server/dealers/monthly-payout";
import { schemeExpired } from "@/server/dealers/scheme-calculator";
import { addSalesperson } from "@/server/dealers/service";
import { setDealerCommissionModel } from "@/server/dealers/tiered";
import { acceptFranchiseAgreement, cancelReservation, lostSlotsRefundPaise, onFranchiseFeeCaptured, releaseHeldPaymentSlots, reserveZones, startBookingPayment, startRenewal } from "@/server/franchise/booking";
import { calculateAllocationMonth } from "@/server/franchise/commission";
import { saveFranchiseConfig } from "@/server/franchise/config";
import { runFranchiseJob } from "@/server/franchise/jobs";
import { setShopArea, zoneViews } from "@/server/franchise/zones";
import { clawBackShopFeeRefund } from "@/server/flows/f22-commission";
import { cappedTailEnd } from "@/server/flows/wave4";
import { downgradeToAgent } from "@/server/onboarding-v2/team";
import { getGatewayByName } from "@/server/payments/gateway/registry";
import type { SandboxGateway } from "@/server/payments/gateway/sandbox";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { reconcileIntent } from "@/server/payments/processing";
import { myReferralCodes } from "@/server/services/referral-links";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setCommissionRate } from "@/server/services/finance";
import { updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { RULES } from "@/server/config/rules";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };

const Z3 = "GKZ-PUN-03";
const Z7 = "GKZ-PUN-07";
const Z47 = "GKZ-PUN-47";
const AREA: Record<string, string> = { [Z3]: "Shivajinagar", [Z7]: "Karve Nagar", [Z47]: "Pirangut" };
const W4: FeatureFlagKey[] = ["flow_f7", "flow_f8", "flow_f9", "flow_f10", "flow_f12", "flow_f21", "flow_f22"];

async function flags(on: boolean, keys: FeatureFlagKey[]) {
  for (const k of keys) await setFeatureFlag(k, { enabled: on, districtCodes: null }, `${on ? "on" : "off"} (wave 4 test)`, admin);
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionInvoices);
  await db.delete(dealerCommissionInvoiceCounters);
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  await db.delete(franchiseNotificationLog);
  await db.delete(franchiseCalcRuns);
  await db.delete(franchiseMonthlySnapshots);
  await db.delete(franchiseShopTeamPeriods);
  await db.delete(franchiseZones).where(eq(franchiseZones.isTest, true));
  await db.update(franchiseZones).set({ status: "AVAILABLE", statusReason: null, reservedForDealerId: null, reservedUntil: null, maxOwners: 2 });
  await db.delete(franchiseConfigVersions);
  await db.update(franchiseCampaigns).set({ closedAt: null, closedReason: null, ownersAtClose: null, areasAtClose: null });
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionSettings({ catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, autoApproveAtMonthEnd: true, payoutDayOfMonth: 5 }, "test defaults", admin);
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", admin);
  for (const key of ["dealerTieredCommission", "dealerPayouts", "dealerPayoutTds", "franchiseFlowsV3"]) await db.execute(sql`delete from platform_settings where key = ${key}`);
  await setRule("dealerTieredCommission", { ...RULES.dealerTieredCommission.defaults, enabled: true }, admin);
  clearRuleCache();
  await setCommissionRate({ scope: "DEFAULT", rateBp: 200 }, admin);
  await saveFranchiseConfig({ bookingOpen: true, allowProvisionalSale: true, promoFeePaise: null }, { reason: "open for the tests" }, admin);
  await flags(false, W4);
});

/* ================================================================ helpers (as tests/integration/franchise-pmr.test.ts) */

async function areaId(name: string): Promise<string> {
  const [a] = await db.select({ id: franchiseAreas.id }).from(franchiseAreas).where(eq(franchiseAreas.name, name));
  return a.id;
}

async function dealer(name = `Dealer ${Math.random().toString(36).slice(2, 6)}`, extra: Partial<typeof dealers.$inferInsert> = {}) {
  const user = await createUser({ role: "DEALER" });
  const [d] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", tierAgreementVersion: AGENT_AGREEMENT_VERSION, tierAgreementAcceptedAt: new Date(), ...extra })
    .returning();
  await setDealerCommissionModel(d.id, "TIERED", "model A team (test)", admin);
  const actor = { id: user.id, role: "DEALER" as const };
  await acceptFranchiseAgreement(actor, FRANCHISE_AGREEMENT_VERSION, { ipAddress: "127.0.0.1", userAgent: "vitest" });
  return { dealer: d, actor, user };
}
type Owner = Awaited<ReturnType<typeof dealer>>;

/** The fake-intent capture the franchise tests use (no gateway). */
async function capture(bookingId: string) {
  const [b] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  const intent = { id: b.paymentIntentId ?? randomUUID(), purpose: "FRANCHISE_FEE", referenceId: b.id, userId: null, amountPaise: Number(b.totalPaise), refundedPaise: 0, status: "CAPTURED", gateway: "SANDBOX", gatewayOrderId: null, gatewayPaymentId: null } as unknown as PaymentIntentRef;
  const after: (() => Promise<void>)[] = [];
  await db.transaction((tx) => onFranchiseFeeCaptured(intent, tx, (task) => after.push(task)));
  for (const task of after) await task();
}

async function book(o: Owner, zoneIds: string[]) {
  const r = await reserveZones(o.actor, { zoneIds });
  await capture(r.booking.id);
  return r;
}

const bookingRow = async (id: string) => (await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, id)))[0];
const allocsOf = (bookingId: string) => db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, bookingId));
const intentRow = async (id: string) => (await db.select().from(paymentIntents).where(eq(paymentIntents.id, id)))[0];

/** Reserve, open the sandbox checkout, and let the hold run out while paying (hold moved 5 minutes into the past). */
async function payingPastHold(o: Owner, zoneIds: string[]) {
  const r = await reserveZones(o.actor, { zoneIds });
  const started = await startBookingPayment(r.booking.id, o.actor);
  const past = new Date(Date.now() - 5 * 60_000);
  await db.update(franchiseBookings).set({ holdExpiresAt: past }).where(eq(franchiseBookings.id, r.booking.id));
  await db.update(franchiseAllocations).set({ holdExpiresAt: past }).where(eq(franchiseAllocations.bookingId, r.booking.id));
  return { booking: r.booking, intentId: started.intent.id };
}

/** The buyer's payment goes through at the sandbox gateway, and is applied as the webhook / reconcile would. */
async function sandboxPays(intentId: string) {
  const sandbox = getGatewayByName("SANDBOX") as SandboxGateway;
  await sandbox.simulate((await intentRow(intentId)).gatewayOrderId!, "SUCCESS");
  await reconcileIntent(intentId);
}

async function signed(dealerId: string, signerId: string | null, basePaise: number, areaName: string) {
  const shopOwner = await createUser({ role: "SHOP_OWNER" });
  const gst = Math.round(basePaise * 0.18);
  const shop = await createShop(shopOwner.id, { name: `S ${Math.random().toString(36).slice(2, 7)}`, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: basePaise + gst });
  await db.update(shops).set({ registrationFeeBasePaise: basePaise, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: gst, phone: `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}` }).where(eq(shops.id, shop.id));
  await db.transaction(async (tx) => setShopArea(tx, shop.id, await areaId(areaName), { source: "REGISTRATION" }));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, salespersonId: signerId, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
  await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: basePaise + gst, method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) await db.insert(sellerVerifications).values({ shopId: shop.id, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
  await approveShop(shop.id, { classification: "KESARI" }, admin);
  return shop;
}

async function deliver(shopId: string, subtotalPaise: number) {
  const buyer = await createUser();
  const order = await createOrder(buyer.id, shopId, { status: "OUT_FOR_DELIVERY", subtotalPaise, paidAt: new Date() });
  await db.update(orders).set({ deliveryAddressSnapshot: { line1: "1 Buyer Road", city: "Pune", pincode: "411030" } }).where(eq(orders.id, order.id));
  await updateOrderStatus(order.id, "DELIVERED", admin);
  return order;
}

const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

/* ================================================================ F7 */

describe("F7 franchise: no shop, no franchise; plan renewal without PAN", () => {
  it("on: a paid booking without a plan needs a live shop (reserve and payment); off: unchanged", async () => {
    await flags(true, ["flow_f7"]);
    const o = await dealer();
    await expect(reserveZones(o.actor, { zoneIds: [Z7] })).rejects.toThrow(/Register your shop first/);
    await createShop(o.user.id, { status: "APPROVED" });
    const r = await reserveZones(o.actor, { zoneIds: [Z7] });
    expect(r.booking.status).toBe("RESERVED");
    // The shop closes before paying: the payment is refused too.
    await db.update(shops).set({ status: "SUSPENDED" }).where(eq(shops.ownerId, o.user.id));
    await expect(startBookingPayment(r.booking.id, o.actor)).rejects.toThrow(/Register your shop first/);

    await flags(false, ["flow_f7"]);
    const o2 = await dealer();
    expect((await reserveZones(o2.actor, { zoneIds: [Z3] })).booking.status).toBe("RESERVED");
  });

  async function planFranchise(months: number) {
    const o = await dealer();
    const r = await book(o, [Z7]);
    const [plan] = await db.select().from(franchisePlans).limit(1);
    await db.update(franchiseBookings).set({ planId: plan.id, planCode: plan.code, planDurationMonths: months }).where(eq(franchiseBookings.id, r.booking.id));
    const [a] = await allocsOf(r.booking.id);
    const expiresAt = new Date(Date.now() + 10 * 86_400_000);
    await db.update(franchiseAllocations).set({ expiresAt }).where(eq(franchiseAllocations.id, a.id));
    await db.update(dealers).set({ panHash: null }).where(eq(dealers.id, o.dealer.id));
    return { o, allocationId: a.id, expiresAt };
  }

  it("off: a plan franchisee without PAN is asked for it before renewing", async () => {
    const { o, allocationId } = await planFranchise(24);
    await expect(startRenewal(allocationId, o.actor)).rejects.toThrow(/PAN/);
  });

  it("on: a plan franchisee renews without PAN, and the renewal runs for the plan's term", async () => {
    const { o, allocationId, expiresAt } = await planFranchise(24);
    await flags(true, ["flow_f7"]);
    const started = await startRenewal(allocationId, o.actor);
    await sandboxPays(started.intent.id);
    const [a] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, allocationId));
    expect(a.renewalCount).toBe(1);
    expect(a.expiresAt!.getTime()).toBe(renewedExpiry(expiresAt, 24).getTime());
  });
});

/* ================================================================ F21 */

describe("F21 zone hold", () => {
  it("on: one active hold per dealer (a second is refused until the first is paid or cancelled); off: several", async () => {
    await flags(true, ["flow_f21"]);
    const o = await dealer();
    const first = await reserveZones(o.actor, { zoneIds: [Z7] });
    await expect(reserveZones(o.actor, { zoneIds: [Z3] })).rejects.toThrow(/one booking at a time/);
    await cancelReservation(first.booking.id, o.actor);
    expect((await reserveZones(o.actor, { zoneIds: [Z3] })).booking.status).toBe("RESERVED");

    await flags(false, ["flow_f21"]);
    const o2 = await dealer();
    await reserveZones(o2.actor, { zoneIds: [Z7] });
    expect((await reserveZones(o2.actor, { zoneIds: [Z47] })).booking.status).toBe("RESERVED");
  });

  it("a held slot is counted as on hold for others", async () => {
    const o = await dealer();
    await reserveZones(o.actor, { zoneIds: [Z7] });
    const [z] = await zoneViews({ zoneIds: [Z7] });
    expect(z).toMatchObject({ held: 1, slotsFree: 1 });
  });

  it("on: the gateway order ends with the hold, and the slot is released at hold + grace while paying; off: kept", async () => {
    await flags(true, ["flow_f21"]);
    const o = await dealer();
    const r = await reserveZones(o.actor, { zoneIds: [Z7] });
    const started = await startBookingPayment(r.booking.id, o.actor);
    const intent = await intentRow(started.intent.id);
    expect(Math.abs(intent.expiresAt!.getTime() - r.booking.holdExpiresAt.getTime())).toBeLessThan(61_000);
    const past = new Date(Date.now() - 5 * 60_000);
    await db.update(franchiseAllocations).set({ holdExpiresAt: past }).where(eq(franchiseAllocations.bookingId, r.booking.id));
    await runFranchiseJob();
    expect((await allocsOf(r.booking.id)).map((a) => a.status)).toEqual(["RESERVATION_EXPIRED"]);
    expect((await bookingRow(r.booking.id)).status).toBe("PAYMENT_PENDING");

    await flags(false, ["flow_f21"]);
    const o2 = await dealer();
    const r2 = await reserveZones(o2.actor, { zoneIds: [Z3] });
    await startBookingPayment(r2.booking.id, o2.actor);
    await db.update(franchiseAllocations).set({ holdExpiresAt: past }).where(eq(franchiseAllocations.bookingId, r2.booking.id));
    await runFranchiseJob();
    expect((await allocsOf(r2.booking.id)).map((a) => a.status)).toEqual(["PAYMENT_PENDING_VERIFICATION"]);
  });

  it("on: a late payment while the slot is still free is confirmed", async () => {
    await flags(true, ["flow_f21"]);
    const o = await dealer();
    const { booking, intentId } = await payingPastHold(o, [Z7]);
    expect(await releaseHeldPaymentSlots(db, new Date(), 2)).toEqual([Z7]);
    await sandboxPays(intentId);
    expect((await bookingRow(booking.id)).status).toBe("PAID");
    expect((await allocsOf(booking.id)).map((a) => a.status)).toEqual(["ACTIVE"]);
    expect(await db.select().from(paymentRefunds)).toHaveLength(0);
  });

  it("on: its own slot taken but the zone's other slot free — the other slot is taken; off: lost, refund due by hand", async () => {
    for (const on of [true, false]) {
      await flags(on, ["flow_f21"]);
      const zone = on ? Z7 : Z3;
      const a = await dealer();
      const { booking, intentId } = await payingPastHold(a, [zone]);
      await releaseHeldPaymentSlots(db, new Date(), 2);
      const b = await dealer();
      await book(b, [zone]); // takes slot 1, freed by the release
      await sandboxPays(intentId);
      const after = await bookingRow(booking.id);
      const [alloc] = await allocsOf(booking.id);
      if (on) {
        expect(after.status).toBe("PAID");
        expect(alloc).toMatchObject({ status: "ACTIVE", slotNo: 2 });
      } else {
        expect(after).toMatchObject({ status: "PAID", failureReason: expect.stringMatching(/refund due/) });
        expect(alloc.status).toBe("RESERVATION_EXPIRED");
        expect(await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, intentId))).toHaveLength(0);
      }
    }
  });

  it("on: every zone taken meanwhile — the whole payment is refunded automatically through the gateway", async () => {
    await flags(true, ["flow_f21"]);
    await db.update(franchiseZones).set({ maxOwners: 1 }).where(eq(franchiseZones.zoneId, Z7));
    const a = await dealer();
    const { booking, intentId } = await payingPastHold(a, [Z7]);
    await releaseHeldPaymentSlots(db, new Date(), 2);
    await book(await dealer(), [Z7]);
    await sandboxPays(intentId);
    const after = await bookingRow(booking.id);
    expect(after.status).toBe("REFUNDED");
    expect(after.failureReason).toMatch(/started automatically/);
    const refunds = await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, intentId));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amountPaise: Number(booking.totalPaise), status: "SUCCESS" });
    expect((await intentRow(intentId)).status).toBe("REFUNDED");
    // The same capture reported again changes nothing (one refund per booking).
    await reconcileIntent(intentId);
    expect(await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, intentId))).toHaveLength(1);
  });

  it("on: one of two zones taken — that zone's share (fee less coupon, plus GST) is refunded, the other goes live", async () => {
    await flags(true, ["flow_f21"]);
    await db.update(franchiseZones).set({ maxOwners: 1 }).where(sql`${franchiseZones.zoneId} in (${Z3}, ${Z7})`);
    const a = await dealer();
    const { booking, intentId } = await payingPastHold(a, [Z3, Z7]);
    await releaseHeldPaymentSlots(db, new Date(), 2);
    await book(await dealer(), [Z3]);
    const lostAlloc = (await allocsOf(booking.id)).find((x) => x.zoneId === Z3)!;
    await sandboxPays(intentId);
    const allocs = await allocsOf(booking.id);
    expect(allocs.find((x) => x.zoneId === Z7)!.status).toBe("ACTIVE");
    expect((await bookingRow(booking.id)).status).toBe("PAID");
    const [refund] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.intentId, intentId));
    expect(refund.amountPaise).toBe(lostSlotsRefundPaise(booking, [lostAlloc]));
    expect(refund.amountPaise).toBeLessThan(Number(booking.totalPaise));
    expect((await intentRow(intentId)).status).toBe("PARTIALLY_REFUNDED");
  });

  it("off: every zone taken — the booking is paid with 'refund due' and nothing is refunded automatically", async () => {
    await db.update(franchiseZones).set({ maxOwners: 1 }).where(eq(franchiseZones.zoneId, Z7));
    const a = await dealer();
    const { booking, intentId } = await payingPastHold(a, [Z7]);
    await db.update(franchiseAllocations).set({ status: "RESERVATION_EXPIRED" }).where(eq(franchiseAllocations.bookingId, booking.id));
    await book(await dealer(), [Z7]);
    await sandboxPays(intentId);
    expect((await bookingRow(booking.id))).toMatchObject({ status: "PAID", failureReason: expect.stringMatching(/refund due/) });
    expect(await db.select().from(paymentRefunds)).toHaveLength(0);
  });
});

/* ================================================================ F10 */

describe("F10 renewal and the tail", () => {
  async function renewedOnce(on: boolean) {
    await flags(on, ["flow_f10"]);
    const o = await dealer();
    const r = await book(o, [Z7]);
    const [a] = await allocsOf(r.booking.id);
    const firstStart = new Date(Date.now() - 355 * 86_400_000);
    await db.update(franchiseAllocations).set({ activatedAt: firstStart, periodStart: firstStart, expiresAt: new Date(Date.now() + 10 * 86_400_000) }).where(eq(franchiseAllocations.id, a.id));
    const started = await startRenewal(a.id, o.actor);
    expect(started.intent.id).toBeTruthy();
    const [rb] = await db.select().from(franchiseBookings).where(and(eq(franchiseBookings.renewalAllocationId, a.id)));
    await capture(rb.id);
    const [after] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, a.id));
    return { after, firstStart };
  }

  it("on: a new franchise's tail ends 3 years after its start", async () => {
    await flags(true, ["flow_f10"]);
    const r = await book(await dealer(), [Z7]);
    const [a] = await allocsOf(r.booking.id);
    expect(a.tailEndAt!.getTime()).toBeLessThanOrEqual(allocationExpiry(a.activatedAt!, 36).getTime());
  });

  it("on: after a renewal the tail still ends 3 years after the FIRST start (never before the paid term)", async () => {
    const { after, firstStart } = await renewedOnce(true);
    expect(after.renewalCount).toBe(1);
    expect(after.tailEndAt!.getTime()).toBe(allocationExpiry(firstStart, 36).getTime());
    expect(after.tailEndAt!.getTime()).toBeGreaterThanOrEqual(after.expiresAt!.getTime());
  });

  it("off: a renewal starts a new 2-year tail after the last expiry (beyond 3 years)", async () => {
    const { after, firstStart } = await renewedOnce(false);
    expect(after.tailEndAt!.getTime()).toBeGreaterThan(allocationExpiry(firstStart, 36).getTime());
  });

  it("the cap never cuts the paid term; free dealer one-time commission stops after the scheme's 12 months", () => {
    const start = new Date("2026-01-01T00:00:00+05:30");
    const expiresAt = allocationExpiry(start, 48);
    expect(cappedTailEnd({ firstStartAt: start, expiresAt, tailEnd: allocationExpiry(start, 72), capYears: 3 }).getTime()).toBe(expiresAt.getTime());
    const terms = { validityMonths: 12 } as never;
    expect(schemeExpired({ terms, startsAt: new Date(Date.now() - 366 * 86_400_000) }, new Date())).toBe(true);
    expect(schemeExpired({ terms, startsAt: new Date(Date.now() - 300 * 86_400_000) }, new Date())).toBe(false);
  });
});

/* ================================================================ F9 */

describe("F9 recurring commission: own shops anywhere, the zone's first franchise keeps the others", () => {
  async function scenario(on: boolean) {
    await flags(on, ["flow_f9"]);
    const A = await dealer("Owner A");
    const B = await dealer("Owner B");
    const C = await dealer("Free C");
    const ra = await book(A, [Z3]);
    // B's free shop in the zone before he buys: attributed to A (first franchise) under F9.
    const bEarly = await signed(B.dealer.id, null, 100_000, AREA[Z3]);
    const rb = await book(B, [Z3]);
    const cShop = await signed(C.dealer.id, null, 100_000, AREA[Z3]);
    const bOwn = await signed(B.dealer.id, null, 100_000, AREA[Z3]);
    const aAway = await signed(A.dealer.id, null, 100_000, AREA[Z47]);
    for (const s of [bEarly, cShop, bOwn, aAway]) await deliver(s.id, 1_000_000);
    const [allocA] = await allocsOf(ra.booking.id);
    const [allocB] = await allocsOf(rb.booking.id);
    const month = thisMonth();
    const a = await calculateAllocationMonth(db, allocA, month);
    const b = await calculateAllocationMonth(db, allocB, month);
    const line = (calc: typeof a, shopId: string) => calc.lines.find((l) => l.shopId === shopId) ?? null;
    return { a, b, line, bEarly, cShop, bOwn, aAway };
  }

  it("on: free-dealer shops and the second buyer's earlier shops stay with the first; own shops anywhere count", async () => {
    const { a, b, line, bEarly, cShop, bOwn, aAway } = await scenario(true);
    expect(line(a, cShop.id)!.netPaise).toBe(line(a, cShop.id)!.fullPaise);
    expect(line(b, cShop.id)).toBeNull();
    expect(line(a, bEarly.id)!.netPaise).toBe(line(a, bEarly.id)!.fullPaise);
    expect(line(b, bEarly.id)).toBeNull();
    expect(line(b, bOwn.id)!.netPaise).toBe(line(b, bOwn.id)!.fullPaise);
    expect(line(a, bOwn.id)).toBeNull();
    expect(line(a, aAway.id)!.netPaise).toBeGreaterThan(0);
    expect(await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, bEarly.id))).toHaveLength(0);
  });

  it("off: the zone's other shops are split 50/50, the second buyer's earlier shops move to him, own shops elsewhere earn nothing", async () => {
    const { a, b, line, bEarly, cShop, aAway } = await scenario(false);
    expect(line(a, cShop.id)!.netPaise * 2).toBe(line(a, cShop.id)!.fullPaise);
    expect(line(b, cShop.id)!.netPaise * 2).toBe(line(b, cShop.id)!.fullPaise);
    expect(line(b, bEarly.id)!.netPaise).toBe(line(b, bEarly.id)!.fullPaise);
    expect(line(a, aAway.id)).toBeNull();
  });
});

/* ================================================================ F8 */

describe("F8 team: downgrading a team lead", () => {
  async function team() {
    await setFeatureFlag("onboarding_v2", { enabled: true, districtCodes: null }, "on (test)", admin);
    const o = await dealer();
    const add = async (name: string, role: "TEAM_LEAD" | "AGENT", parentId: string | null = null): Promise<DealerSalesperson> => {
      const v = await addSalesperson(o.dealer.id, { employeeId: name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12), name, role, parentId }, admin);
      const [m] = await db.update(dealerSalespeople).set({ panHash: `pan-${v.id}`, bankStatus: "VERIFIED" }).where(eq(dealerSalespeople.id, v.id)).returning();
      return m;
    };
    const lead = await add("Lead One", "TEAM_LEAD");
    const lead2 = await add("Lead Two", "TEAM_LEAD");
    const agent = await add("Agent One", "AGENT", lead.id);
    return { o, lead, lead2, agent };
  }

  it("off: refused while he still leads agents", async () => {
    const { o, lead } = await team();
    await expect(downgradeToAgent(o.actor, lead.id, {})).rejects.toThrow(/still leads 1 agent/);
  });

  it("on: his agents move to the team lead chosen (or to the dealer) in the same step", async () => {
    await flags(true, ["flow_f8"]);
    const { o, lead, lead2, agent } = await team();
    const after = await downgradeToAgent(o.actor, lead.id, { agentsTo: lead2.id });
    expect(after.teamRole).toBe("AGENT");
    const [moved] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, agent.id));
    expect(moved).toMatchObject({ parentId: lead2.id, depth: 3 });
    await expect(downgradeToAgent(o.actor, lead2.id, { agentsTo: lead2.id })).rejects.toThrow(/another team lead/);
    await downgradeToAgent(o.actor, lead2.id, {});
    const [toDealer] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, agent.id));
    expect(toDealer).toMatchObject({ parentId: null, depth: 2 });
  });
});

/* ================================================================ F12 */

describe("F12 referral codes", () => {
  it("on: listing the account's codes makes its customer code; off: not until its own page", async () => {
    const u1 = await createUser();
    await myReferralCodes(u1.id);
    expect(await db.select().from(customerReferralCodes).where(eq(customerReferralCodes.userId, u1.id))).toHaveLength(0);
    await flags(true, ["flow_f12"]);
    const u2 = await createUser();
    const codes = await myReferralCodes(u2.id);
    expect(codes.find((c) => c.kind === "CUSTOMER")?.code).toMatch(/^GK[A-Z0-9]{6}$/);
  });
});

/* ================================================================ F22 */

describe("F22 commission: held, taxed, invoiced, clawed back", () => {
  const MONTH = "2026-10";
  async function entry(dealerId: string, amountPaise: number, createdAt: Date) {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { status: "APPROVED" });
    const [e] = await db
      .insert(dealerCommissionLedger)
      .values({ dealerId, shopId: shop.id, milestone: "ACTIVATED", kind: "ACCRUAL", entryType: "BASE", accrualKey: `T:${randomUUID()}`, basePaise: amountPaise, amountPaise, status: "EARNED", createdAt })
      .returning();
    return e;
  }

  it("on: an entry earned less than 3 days before the close waits for the next month; off: paid now", async () => {
    const { end } = monthBounds(MONTH);
    const closeAt = new Date(end.getTime() + 86_400_000);
    for (const on of [true, false]) {
      await db.delete(dealerCommissionMonths);
      await flags(on, ["flow_f22"]);
      const o = await dealer();
      const recent = await entry(o.dealer.id, 30_000, new Date(end.getTime() - 12 * 3_600_000));
      await entry(o.dealer.id, 70_000, new Date(end.getTime() - 5 * 86_400_000));
      const r = await closeCommissionMonth(MONTH, admin, closeAt);
      const mine = r.payouts.find((p) => p.dealerId === o.dealer.id)!;
      expect(mine.totalPaise).toBe(on ? 70_000 : 100_000);
      const [after] = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.id, recent.id));
      expect(after.status).toBe(on ? "EARNED" : "APPROVED");
      expect(after.payoutBatchId === null).toBe(on);
    }
  });

  it("on: a GST-registered dealer's payout adds GST with a numbered commission invoice; the statement shows it", async () => {
    await flags(true, ["flow_f22"]);
    const { end } = monthBounds(MONTH);
    const mh = await dealer("MH Dealer", { gstin: "27AAPFU0939F1ZV" });
    const ka = await dealer("KA Dealer", { gstin: "29AAPFU0939F1ZR" });
    const plain = await dealer("No GST");
    for (const d of [mh, ka, plain]) await entry(d.dealer.id, 100_000, new Date(end.getTime() - 5 * 86_400_000));
    await closeCommissionMonth(MONTH, admin, new Date(end.getTime() + 86_400_000));
    const batchOf = async (dealerId: string) => (await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.dealerId, dealerId)))[0];
    const bMh = await batchOf(mh.dealer.id);
    const bKa = await batchOf(ka.dealer.id);
    expect(bMh).toMatchObject({ totalPaise: 100_000, gstPaise: 18_000, gstRateBp: 1800 });
    expect((await batchOf(plain.dealer.id)).gstPaise).toBe(0);
    const invoices = await db.select().from(dealerCommissionInvoices);
    expect(invoices).toHaveLength(2);
    const invMh = invoices.find((i) => i.batchId === bMh.id)!;
    const invKa = invoices.find((i) => i.batchId === bKa.id)!;
    expect(invMh).toMatchObject({ supply: "INTRA", cgstPaise: 9_000, sgstPaise: 9_000, igstPaise: 0, totalPaise: 118_000 });
    expect(invKa).toMatchObject({ supply: "INTER", igstPaise: 18_000 });
    expect([invMh.invoiceNumber, invKa.invoiceNumber].sort()).toEqual(["GKC/2627/000001", "GKC/2627/000002"]);
    expect(bMh.gstInvoiceId).toBe(invMh.id);
    const s = await dealerMonthStatement(mh.dealer.id, MONTH);
    expect(s.payout).toMatchObject({ totalPaise: 100_000, gstPaise: 18_000, netPaise: 118_000 });
    const csv = monthStatementCsv(s);
    expect(csv).toMatch(/GST added/);
    expect(csv).toMatch(/Reversals \(clawback\)/);
  });

  it("off: no GST, no invoice, the statement as before", async () => {
    const { end } = monthBounds(MONTH);
    const mh = await dealer("MH Dealer", { gstin: "27AAPFU0939F1ZV" });
    await entry(mh.dealer.id, 100_000, new Date(end.getTime() - 5 * 86_400_000));
    await closeCommissionMonth(MONTH, admin, new Date(end.getTime() + 86_400_000));
    const [b] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.dealerId, mh.dealer.id));
    expect(b.gstPaise).toBe(0);
    expect(await db.select().from(dealerCommissionInvoices)).toHaveLength(0);
    const csv = monthStatementCsv(await dealerMonthStatement(mh.dealer.id, MONTH));
    expect(csv).not.toMatch(/GST added/);
  });

  it("a shop fee refunded in full through the gateway takes back the chain's commission (on); off: nothing", async () => {
    for (const on of [false, true]) {
      await flags(on, ["flow_f22"]);
      const o = await dealer();
      const shop = await signed(o.dealer.id, null, 100_000, AREA[Z7]);
      const accrued = await db.select().from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.shopId, shop.id), eq(dealerCommissionLedger.kind, "ACCRUAL")));
      expect(accrued.length).toBeGreaterThan(0);
      await clawBackShopFeeRefund({ purpose: "SHOP_REGISTRATION_FEE", referenceId: shop.id, amountPaise: 118_000, refundedPaise: 118_000 });
      // Unpaid entries become REVERSED (a paid one would get a negative entry for the next payout).
      const rows = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shop.id));
      expect(rows.filter((r) => r.kind === "ACCRUAL").every((r) => r.status === "REVERSED")).toBe(on);
      expect(rows.some((r) => r.status === "REVERSED" || r.kind === "REVERSAL")).toBe(on);
    }
  });
});
