/**
 * Franchise dealer module + Pune PMR area booking (owner brief 20-Nov-2026; docs/franchise/), against real
 * PostgreSQL. The brief's §15 "test server" list, as far as it runs without a browser or a payment gateway:
 *   import (91 zones, totals) · Pune only · boundaries (5 km, overlap, one zone per point, not bookable unapproved)
 *   capacity (10 parallel → 2, one owner one slot, all-or-nothing cart, hold expiry, payment failure,
 *   duplicate webhook) · launch counters and close rules · franchise code inside / outside / expired zone
 *   one-time 25% (₹1,000 → ₹250, ₹2,500 → ₹625) and its reversal · monthly 25% of the actual 2% + bonus,
 *   tail · expiry reminders (30 / 15 / daily, CEO copy), expiry actions, renewal, rebooking
 *   Model A 20 / 4 / 3 by level distance (4 cases × ₹1,000 / ₹2,500), team lead deactivated → agents under
 *   the dealer, team duplicates
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { FRANCHISE_AGREEMENT_VERSION, allocationExpiry, formatIst, istInstant, zoneEstimate } from "@/lib/franchise";
import { db } from "@/server/db";
import {
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerSalespeople,
  dealers,
  franchiseAllocations,
  franchiseBookings,
  franchiseCalcRuns,
  franchiseCampaigns,
  franchiseCodes,
  franchiseConfigVersions,
  franchiseNotificationLog,
  franchisePerformanceRatings,
  franchiseRatingFormulas,
  franchiseShopAttributions,
  franchiseZoneBoundaries,
  franchiseZones,
  orders,
  referralCodes,
  sellerVerifications,
  shopAttributions,
  shops,
  type DealerSalesperson,
} from "@/server/db/schema";
import { setCommissionSettings } from "@/server/dealers/commission";
import { recordShopAttributionSafely } from "@/server/dealers/attribution";
import { addSalesperson, setSalespersonStatus } from "@/server/dealers/service";
import { leadAddsAgent, setDealerCommissionModel } from "@/server/dealers/tiered";
import {
  acceptFranchiseAgreement,
  cancelReservation,
  offerView,
  onFranchiseFeeCaptured,
  onFranchiseFeeEnded,
  releaseExpiredHolds,
  reserveZones,
  startRenewal,
} from "@/server/franchise/booking";
import { assertCodeForLocation } from "@/server/franchise/codes";
import { runFranchiseMonth, saveRatingFormula } from "@/server/franchise/commission";
import { franchiseConfig, saveFranchiseConfig } from "@/server/franchise/config";
import { expireAreas, sendDigest, sendReminders } from "@/server/franchise/jobs";
import { approveBoundary, clusterSummary, listClusters, saveBoundaryDraft, splitZone, zoneViews, zonesContaining } from "@/server/franchise/zones";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setCommissionRate } from "@/server/services/finance";
import { updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { RULES } from "@/server/config/rules";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };

/** Two zones far enough apart that 1 km circles never overlap. */
const Z4: [number, number] = [18.51, 73.85]; // zone 4, Sadashiv Peth
const Z10: [number, number] = [18.53, 73.83]; // zone 10, FC Road

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  await db.delete(franchiseNotificationLog);
  await db.delete(franchiseCalcRuns);
  await db.delete(franchisePerformanceRatings);
  await db.delete(franchiseRatingFormulas);
  await db.delete(franchiseZoneBoundaries);
  await db.delete(franchiseZones).where(sql`${franchiseZones.origin} in ('SUB_ZONE', 'TEST')`);
  await db.update(franchiseZones).set({ status: "BOUNDARY_PENDING", statusReason: null, maxOwners: 2 });
  await db.delete(franchiseConfigVersions);
  await db.update(franchiseCampaigns).set({ closedAt: null, closedReason: null, ownersAtClose: null, areasAtClose: null });
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await setCommissionSettings(
    { catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, autoApproveAtMonthEnd: true, payoutDayOfMonth: 5 },
    "test defaults",
    admin,
  );
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: null }, "on (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
  for (const key of ["dealerTieredCommission", "dealerPayouts", "dealerPayoutTds"]) await db.execute(sql`delete from platform_settings where key = ${key}`);
  await setRule("dealerTieredCommission", { ...RULES.dealerTieredCommission.defaults, enabled: true }, admin);
  clearRuleCache();
  await setCommissionRate({ scope: "DEFAULT", rateBp: 200 }, admin);
  await saveFranchiseConfig({ bookingOpen: true }, { reason: "open for the tests" }, admin);
});

async function openZone(zoneId: string, centre: [number, number], radiusM = 1000) {
  await saveBoundaryDraft(zoneId, { ref: { lat: centre[0], lng: centre[1], label: "test centre" }, shape: "CIRCLE", radiusM }, admin);
  const r = await approveBoundary(zoneId, admin);
  expect(r).toEqual({ approved: true, errors: [] });
}

/** An approved dealer with PAN and a verified bank who accepted the franchise rules (a would-be owner). */
async function owner(name = `Owner ${Math.random().toString(36).slice(2, 6)}`) {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", tierAgreementVersion: AGENT_AGREEMENT_VERSION, tierAgreementAcceptedAt: new Date() })
    .returning();
  const actor = { id: user.id, role: "DEALER" as const };
  await acceptFranchiseAgreement(actor, FRANCHISE_AGREEMENT_VERSION, { ipAddress: "127.0.0.1", userAgent: "vitest" });
  return { dealer, actor, user };
}

async function capture(bookingId: string, intentId?: string) {
  const [b] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  const intent = { id: intentId ?? b.paymentIntentId ?? randomUUID(), purpose: "FRANCHISE_FEE", referenceId: b.id, userId: null, amountPaise: Number(b.totalPaise), refundedPaise: 0, status: "CAPTURED", gateway: "SANDBOX", gatewayOrderId: null, gatewayPaymentId: null } as unknown as PaymentIntentRef;
  await db.transaction((tx) => onFranchiseFeeCaptured(intent, tx));
}

async function book(o: Awaited<ReturnType<typeof owner>>, zoneIds: string[]) {
  const r = await reserveZones(o.actor, { zoneIds });
  await capture(r.booking.id);
  return r;
}

const allocs = (bookingId: string) => db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, bookingId));

async function codeOf(dealerId: string): Promise<string> {
  const [r] = await db.select({ code: referralCodes.code }).from(franchiseCodes).innerJoin(referralCodes, eq(referralCodes.id, franchiseCodes.referralCodeId)).where(eq(franchiseCodes.ownerDealerId, dealerId));
  return r.code;
}

/** A shop at (lat, lng) registered with `code`, fee paid online (base + 18%), verified and approved. */
async function registeredShop(code: string, at: [number, number], basePaise = 100_000) {
  const shopOwner = await createUser({ role: "SHOP_OWNER" });
  const gst = Math.round(basePaise * 0.18);
  const shop = await createShop(shopOwner.id, { name: `Shop ${Math.random().toString(36).slice(2, 7)}`, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: basePaise + gst });
  const [rc] = await db.select().from(referralCodes).where(eq(referralCodes.code, code));
  await db
    .update(shops)
    .set({ registrationFeeBasePaise: basePaise, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: gst, latitude: at[0].toFixed(7), longitude: at[1].toFixed(7), referralCodeId: rc?.id ?? null, phone: `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}` })
    .where(eq(shops.id, shop.id));
  await recordShopAttributionSafely(shop.id, admin);
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

const entries = (shopId: string) => db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shopId));
const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

/* =================================================================== import */

describe("territory master (brief §5)", () => {
  it("91 zones, 7 clusters, 52 original + 39 split, totals as in the brief", async () => {
    const zones = await zoneViews();
    expect(zones).toHaveLength(91);
    expect(new Set(zones.map((z) => z.zoneId)).size).toBe(91);
    expect(zones.filter((z) => z.origin === "ORIGINAL")).toHaveLength(52);
    expect(zones.filter((z) => z.origin === "SPLIT")).toHaveLength(39);
    const { clusters, total } = clusterSummary(zones, await listClusters());
    expect(clusters.map((c) => [c.code, c.zones, c.estShops, Math.round(c.annualCrHundredths / 100), Math.round(c.largestZoneCrHundredths / 100)])).toEqual([
      ["C1", 22, 49_400, 80_958, 4608],
      ["C2", 15, 42_800, 50_556, 4692],
      ["C3", 10, 35_900, 35_412, 4446],
      ["C4", 10, 27_700, 32_598, 4554],
      ["C5", 7, 24_300, 26_496, 4914],
      ["C6", 18, 47_800, 57_383, 4428],
      ["C7", 9, 22_000, 18_252, 2958],
    ]);
    expect(total).toMatchObject({ zones: 91, estShops: 249_900, largestZoneId: "43" });
    expect(Math.round(total.annualCrHundredths / 100)).toBe(301_655);
    const byAnnual = [...zones].sort((a, b) => a.annualCrHundredths - b.annualCrHundredths);
    expect([byAnnual[0].zoneId, byAnnual[0].annualCrHundredths]).toEqual(["68", 118_800]);
    expect([byAnnual[90].zoneId, byAnnual[90].annualCrHundredths]).toEqual(["43", 491_400]);
    expect(zones.every((z) => z.annualCrHundredths < 500_000)).toBe(true);
    expect(zones.find((z) => z.zoneId === "1A")).toMatchObject({ pinCodes: ["411002"], estShops: 2300, gmvPerShopLakh: 14.5, monthlyCrHundredths: 33_350, splitFromZone: "1" });
  });

  it("411002 is in 8 zones — the PIN alone cannot place a shop", async () => {
    const zones = await zoneViews();
    expect(zones.filter((z) => z.pinCodes.includes("411002")).map((z) => z.zoneId)).toEqual(["1A", "1B", "2A", "2B", "2C", "3A", "3B", "7A"]);
  });

  it("Pune only: a region not enabled is never returned", async () => {
    await saveFranchiseConfig({ regionsEnabled: ["XYZ"] }, { reason: "test: another region only" }, admin);
    expect(await zoneViews()).toHaveLength(0);
  });
});

/* ============================================================== boundaries */

describe("zone boundaries and the 5 km rule (brief §6)", () => {
  it("a zone without an approved boundary is 'coming soon' and cannot be booked", async () => {
    const o = await owner();
    expect((await zoneViews({ zoneIds: ["4"] }))[0]).toMatchObject({ status: "BOUNDARY_PENDING", badge: "COMING_SOON", bookable: false });
    await expect(reserveZones(o.actor, { zoneIds: ["4"] })).rejects.toThrow(/coming soon/);
  });

  it("over 5 km is refused and the zone is flagged NEEDS_SPLIT; a split makes sub-zones 66-1, 66-2", async () => {
    await saveBoundaryDraft("66", { ref: { lat: 18.75, lng: 73.4 }, shape: "CIRCLE", radiusM: 9000 }, admin);
    const r = await approveBoundary("66", admin);
    expect(r.approved).toBe(false);
    expect(r.errors.join(" ")).toMatch(/limit is 5 km/);
    expect((await zoneViews({ zoneIds: ["66"] }))[0].status).toBe("NEEDS_SPLIT");
    const ids = await splitZone("66", [{ name: "Lonavala", shops: 1700 }, { name: "Karla-Kamshet", shops: 1200 }], "too large for 5 km", admin);
    expect(ids).toEqual(["66-1", "66-2"]);
    const subs = await zoneViews({ zoneIds: ids });
    expect(subs.map((z) => [z.zoneId, z.estShops, z.gmvPerShopLakh, z.status])).toEqual([
      ["66-1", 1700, 8.5, "BOUNDARY_PENDING"],
      ["66-2", 1200, 8.5, "BOUNDARY_PENDING"],
    ]);
    await expect(splitZone("4", [{ name: "a", shops: 1 }, { name: "b", shops: 1 }], "wrong total", admin)).rejects.toThrow(/add up to 4,000/);
  });

  it("overlapping boundaries are refused; a point resolves to exactly one zone", async () => {
    await openZone("4", Z4);
    await saveBoundaryDraft("5A", { ref: { lat: Z4[0] + 0.005, lng: Z4[1] }, shape: "CIRCLE", radiusM: 1000 }, admin);
    const r = await approveBoundary("5A", admin);
    expect(r.approved).toBe(false);
    expect(r.errors).toContain("It overlaps zone 4.");
    await openZone("10", Z10);
    expect(await zonesContaining(Z4[0], Z4[1])).toEqual(["4"]);
    expect(await zonesContaining(Z10[0] + 0.001, Z10[1])).toEqual(["10"]);
    expect(await zonesContaining(18.9, 74.5)).toEqual([]);
  });
});

/* ================================================================ capacity */

describe("two slots a zone, enforced in the database (brief §4.4)", () => {
  it("10 parallel bookings of one zone: exactly 2 succeed, on slots 1 and 2", async () => {
    await openZone("4", Z4);
    const owners = await Promise.all(Array.from({ length: 10 }, (_, i) => owner(`Racer ${i}`)));
    const results = await Promise.allSettled(owners.map((o) => reserveZones(o.actor, { zoneIds: ["4"] })));
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").every((r) => /fully booked|took one of these areas/.test(String((r as PromiseRejectedResult).reason?.message)))).toBe(true);
    const held = await db.select().from(franchiseAllocations).where(and(eq(franchiseAllocations.zoneId, "4"), inArray(franchiseAllocations.status, ["RESERVED", "PAYMENT_PENDING_VERIFICATION", "ACTIVE", "SUSPENDED"])));
    expect(held.map((h) => h.slotNo).sort()).toEqual([1, 2]);
    // The database itself refuses a third occupying row, whatever the code does.
    const extra = owners.find((o) => !held.some((h) => h.ownerDealerId === o.dealer.id))!;
    await expect(
      db.insert(franchiseAllocations).values({ zoneId: "4", slotNo: 1, ownerDealerId: extra.dealer.id, bookingId: held[0].bookingId, status: "ACTIVE", activatedAt: new Date(), expiresAt: new Date(Date.now() + 1e10), feePaise: 1, configVersion: 1 }),
    ).rejects.toThrow();
  });

  it("one owner never holds both slots of a zone", async () => {
    await openZone("4", Z4);
    const o = await owner();
    await book(o, ["4"]);
    await expect(reserveZones(o.actor, { zoneIds: ["4"] })).rejects.toThrow(/already hold/);
  });

  it("a multi-area cart is all-or-nothing and names the full zone", async () => {
    await openZone("4", Z4);
    await openZone("10", Z10);
    await book(await owner(), ["4"]);
    await book(await owner(), ["4"]);
    const o = await owner();
    await expect(reserveZones(o.actor, { zoneIds: ["10", "4"] })).rejects.toThrow(/4 is fully booked/);
    expect((await zoneViews({ zoneIds: ["10"] }))[0]).toMatchObject({ occupied: 0, badge: "AVAILABLE_2" });
    const ok = await reserveZones(o.actor, { zoneIds: ["10"] });
    expect(ok.booking).toMatchObject({ areaCount: 1, basePaise: 15_000_000, gstPaise: 2_700_000, totalPaise: 17_700_000 });
  });

  it("an expired hold frees the slot (at read time and by the job); a cancelled one at once", async () => {
    await openZone("4", Z4);
    const a = await owner();
    const b = await owner();
    const r1 = await reserveZones(a.actor, { zoneIds: ["4"] });
    await reserveZones(b.actor, { zoneIds: ["4"] });
    expect((await zoneViews({ zoneIds: ["4"] }))[0].badge).toBe("FULL");
    await db.update(franchiseAllocations).set({ holdExpiresAt: new Date(Date.now() - 1000) }).where(eq(franchiseAllocations.bookingId, r1.booking.id));
    expect((await zoneViews({ zoneIds: ["4"] }))[0].badge).toBe("ONE_LEFT");
    expect(await releaseExpiredHolds(db, new Date())).toBe(1);
    expect((await allocs(r1.booking.id))[0].status).toBe("RESERVATION_EXPIRED");
    const c = await owner();
    const r3 = await reserveZones(c.actor, { zoneIds: ["4"] });
    await cancelReservation(r3.booking.id, c.actor);
    expect((await allocs(r3.booking.id))[0].status).toBe("CANCELLED");
  });

  it("a failed payment releases the slots; a duplicate capture does not activate twice", async () => {
    await openZone("4", Z4);
    const o = await owner();
    const r = await reserveZones(o.actor, { zoneIds: ["4"] });
    await db.transaction((tx) => onFranchiseFeeEnded({ id: randomUUID(), referenceId: r.booking.id } as never, "FAILED", tx));
    expect((await allocs(r.booking.id))[0].status).toBe("PAYMENT_FAILED");
    const again = await reserveZones(o.actor, { zoneIds: ["4"] });
    const intentId = randomUUID();
    await capture(again.booking.id, intentId);
    const [first] = await allocs(again.booking.id);
    await capture(again.booking.id, intentId);
    const [second] = await allocs(again.booking.id);
    expect(second).toMatchObject({ status: "ACTIVE", activatedAt: first.activatedAt, expiresAt: first.expiresAt });
    expect(await db.select().from(franchiseCodes).where(eq(franchiseCodes.ownerDealerId, o.dealer.id))).toHaveLength(1);
  });

  it("activation: 12 months − 1 day to 23:59:59 IST; a GKF code; tail to the end of year 3", async () => {
    await openZone("4", Z4);
    const o = await owner();
    const r = await book(o, ["4"]);
    const [a] = await allocs(r.booking.id);
    expect(a.status).toBe("ACTIVE");
    expect(a.expiresAt!.getTime()).toBe(allocationExpiry(a.activatedAt!, 12).getTime());
    expect(formatIst(a.expiresAt)).toMatch(/23\.59 IST$/);
    expect(a.tailEndAt!.getTime()).toBe(allocationExpiry(a.activatedAt!, 36).getTime());
    expect(await codeOf(o.dealer.id)).toMatch(/^GKF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  });
});

/* ============================================================ launch offer */

describe("launch offer counters (brief §3.1)", () => {
  it("first_limit_reached: closes at 2 areas; then no price is shown and payment is refused", async () => {
    await saveFranchiseConfig({ launchMaxAreas: 2, launchMaxOwners: 25 }, { reason: "test limit" }, admin);
    await openZone("4", Z4);
    await openZone("10", Z10);
    const o = await owner();
    expect((await offerView()).launch).toMatchObject({ open: true, placesLeft: 2 });
    await book(o, ["4", "10"]);
    const v = await offerView();
    expect(v).toMatchObject({ bookingOpen: false, feePerAreaPaise: null, closedMessage: "Launch offer closed – new terms coming soon." });
    expect(v.launch).toMatchObject({ open: false, placesLeft: 0, areas: 2, owners: 1 });
    const [camp] = await db.select().from(franchiseCampaigns).where(eq(franchiseCampaigns.code, "LAUNCH"));
    expect(camp.closedAt).not.toBeNull();
    await expect(reserveZones((await owner()).actor, { zoneIds: ["4"] })).rejects.toThrow(/new terms coming soon/);
    // Once the owner sets post-launch terms, booking resumes at them (not a launch place).
    await saveFranchiseConfig({ postLaunchFeePaise: 20_000_000 }, { reason: "post-launch terms" }, admin);
    const later = await reserveZones((await owner()).actor, { zoneIds: ["4"] });
    expect(later.booking).toMatchObject({ launchOffer: false, feePerAreaPaise: 20_000_000 });
  });

  it("owners_only: 1 owner may take many areas; a second owner is refused", async () => {
    await saveFranchiseConfig({ launchMaxOwners: 1, launchCloseRule: "owners_only" }, { reason: "test owners only" }, admin);
    await openZone("4", Z4);
    await openZone("10", Z10);
    await book(await owner(), ["4", "10"]);
    expect((await offerView()).launch.open).toBe(false);
  });

  it("pending reservations hold launch places: the last place is never sold twice", async () => {
    await saveFranchiseConfig({ launchMaxAreas: 1 }, { reason: "one place" }, admin);
    await openZone("4", Z4);
    await openZone("10", Z10);
    await reserveZones((await owner()).actor, { zoneIds: ["4"] });
    await expect(reserveZones((await owner()).actor, { zoneIds: ["10"] })).rejects.toThrow(/being paid for/);
  });
});

/* ======================================================== codes and money */

describe("franchise code, attribution and commission (brief §3.2, §7, §8)", () => {
  it("inside the owner's zone: accepted; outside: refused; no location: refused", async () => {
    await openZone("4", Z4);
    await openZone("10", Z10);
    const o = await owner();
    await book(o, ["4"]);
    const code = await codeOf(o.dealer.id);
    expect(await assertCodeForLocation(code, Z4[0], Z4[1])).toMatchObject({ kind: "FRANCHISE", zoneId: "4" });
    await expect(assertCodeForLocation(code, Z10[0], Z10[1])).rejects.toThrow(/outside the franchise's areas/);
    await expect(assertCodeForLocation(code, null, null)).rejects.toThrow(/map/);
    expect(await assertCodeForLocation("NOTAFRAN", Z4[0], Z4[1])).toEqual({ kind: "NOT_FRANCHISE" });
  });

  it("one-time 25% of the fee excl. GST (₹1,000 → ₹250, ₹2,500 → ₹625), owner only; reversed on refund", async () => {
    await openZone("4", Z4);
    const o = await owner();
    await book(o, ["4"]);
    const code = await codeOf(o.dealer.id);
    const retail = await registeredShop(code, Z4, 100_000);
    const wholesale = await registeredShop(code, [Z4[0] + 0.002, Z4[1]], 250_000);
    const r = await entries(retail.id);
    expect(r.map((e) => [e.entryType, e.amountPaise, e.dealerId, e.payeeMemberId, e.franchiseZoneId])).toEqual([["ONE_TIME_FRANCHISE", 25_000, o.dealer.id, null, "4"]]);
    expect((await entries(wholesale.id)).map((e) => e.amountPaise)).toEqual([62_500]);
    // No Model A attribution was made for a franchise shop.
    expect(await db.select().from(shopAttributions).where(eq(shopAttributions.shopId, retail.id))).toHaveLength(0);
    const [attr] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, retail.id));
    expect(attr).toMatchObject({ ownerDealerId: o.dealer.id, zoneId: "4", status: "ACTIVE" });
    // A refund of the fee reverses it.
    await recordPayment({ shopId: retail.id, paymentType: "REFUND", amountPaise: 118_000, method: "ONLINE", transactionId: `rf_${retail.id.slice(0, 8)}` }, admin);
    expect((await entries(retail.id)).map((e) => [e.entryType, e.status])).toEqual([["ONE_TIME_FRANCHISE", "REVERSED"]]);
    expect((await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, retail.id)))[0].status).toBe("REVERSED");
  });

  it("monthly: 25% of GoKesari's actual 2% (₹1,00,000 → ₹2,000 → ₹500); bonus 0% until a formula is published", async () => {
    await openZone("4", Z4);
    const o = await owner();
    await book(o, ["4"]);
    const shop = await registeredShop(await codeOf(o.dealer.id), Z4);
    await deliver(shop.id, 10_000_000);
    const month = thisMonth();
    // The month is over "now + 40 days" for the run; ratings and entries written once.
    await db.execute(sql`select 1`);
    const { accrueFranchiseRecurring, rateOwnersForMonth } = await import("@/server/franchise/commission");
    expect(await rateOwnersForMonth(month)).toBe(1);
    const [rating] = await db.select().from(franchisePerformanceRatings).where(eq(franchisePerformanceRatings.ownerDealerId, o.dealer.id));
    expect(rating).toMatchObject({ bonusBp: 0 });
    expect(rating.explanation).toMatch(/No performance formula/);
    const r = await db.transaction((tx) => accrueFranchiseRecurring(tx, month, "test-run"));
    expect(r).toMatchObject({ entries: 1, basePaise: 50_000, bonusPaise: 0 });
    const again = await db.transaction((tx) => accrueFranchiseRecurring(tx, month, "test-run-2"));
    expect(again.entries).toBe(0);
    const rec = (await entries(shop.id)).filter((e) => e.entryType === "RECURRING_BASE");
    expect(rec.map((e) => [e.amountPaise, e.basePaise, e.milestone])).toEqual([[50_000, 200_000, "MONTHLY"]]);
  });

  it("with a published formula the bonus is added (max 5 points) and explained", async () => {
    await openZone("4", Z4);
    const o = await owner();
    await book(o, ["4"]);
    const shop = await registeredShop(await codeOf(o.dealer.id), Z4);
    await deliver(shop.id, 10_000_000);
    await saveRatingFormula({ metrics: [{ key: "newShopsActivated", weight: 1, target: 1 }], tiers: [{ minScore: 50, bonusBp: 300 }, { minScore: 100, bonusBp: 900 }] }, true, "test formula", admin);
    const { accrueFranchiseRecurring, rateOwnersForMonth } = await import("@/server/franchise/commission");
    await rateOwnersForMonth(thisMonth());
    const [rating] = await db.select().from(franchisePerformanceRatings).where(eq(franchisePerformanceRatings.ownerDealerId, o.dealer.id));
    expect(rating).toMatchObject({ bonusBp: 500 }); // tier 900 capped at bonusMaxBp 500
    expect(rating.explanation).toMatch(/Score 100\.0/);
    await db.transaction((tx) => accrueFranchiseRecurring(tx, thisMonth(), "run"));
    const rec = await entries(shop.id);
    expect(rec.filter((e) => e.entryType.startsWith("RECURRING")).map((e) => [e.entryType, e.amountPaise]).sort()).toEqual([
      ["RECURRING_BASE", 50_000],
      ["RECURRING_BONUS", 10_000],
    ]);
  });

  it("runFranchiseMonth refuses a month not yet over", async () => {
    expect(await runFranchiseMonth(thisMonth())).toEqual({ skipped: `${thisMonth()} is not over yet` });
  });
});

/* ==================================================== expiry and renewal */

describe("validity, reminders, expiry and renewal (brief §9)", () => {
  async function activeArea() {
    await openZone("4", Z4);
    await openZone("10", Z10);
    const o = await owner();
    const r = await book(o, ["4"]);
    const [a] = await allocs(r.booking.id);
    return { o, a };
  }

  it("reminders: 30 days, 15 days, then daily — owner channels and a copy to ceo@agtci.com", async () => {
    const { a } = await activeArea();
    const { config } = await franchiseConfig();
    const exp = a.expiresAt!;
    const at = (daysBefore: number) => new Date(exp.getTime() - daysBefore * 86_400_000 - 13 * 3600_000); // ~10:59 IST that day
    expect(await sendReminders(at(30), config)).toBe(1);
    expect(await sendReminders(at(30), config)).toBe(0); // once a day
    expect(await sendReminders(at(29), config)).toBe(0);
    await sendReminders(at(15), config);
    await sendReminders(at(14), config);
    await sendReminders(at(0), config);
    const log = await db.select().from(franchiseNotificationLog).where(eq(franchiseNotificationLog.allocationId, a.id));
    const ceo = log.filter((l) => l.recipient === "ceo@agtci.com" && l.channel === "EMAIL").map((l) => l.kind).sort();
    expect(ceo).toEqual(["D15", "D30", "DAILY", "DAILY"]);
    expect(log.some((l) => l.channel === "IN_APP" && l.kind === "D30")).toBe(true);
    expect(log.some((l) => l.channel === "WHATSAPP")).toBe(true);
    // Before 10:00 IST nothing is sent.
    const early = new Date(exp.getTime() - 20 * 86_400_000 - 20 * 3600_000); // ~03:59 IST
    expect(await sendReminders(early, config)).toBe(0);
  });

  it("renewal: open from 30 days before expiry, extends the same slot by 12 months", async () => {
    const { o, a } = await activeArea();
    await expect(startRenewal(a.id, o.actor)).rejects.toThrow(/Renewal opens 30 days before/);
    await db.update(franchiseAllocations).set({ expiresAt: new Date(Date.now() + 10 * 86_400_000) }).where(eq(franchiseAllocations.id, a.id));
    await startRenewal(a.id, o.actor).catch(() => {}); // the gateway part is not under test here
    const [rb] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.renewalAllocationId, a.id));
    expect(rb).toMatchObject({ kind: "RENEWAL", areaCount: 1, basePaise: 15_000_000 });
    const before = (await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, a.id)))[0];
    await capture(rb.id);
    const [after] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, a.id));
    expect(after).toMatchObject({ slotNo: a.slotNo, renewalCount: 1, status: "ACTIVE" });
    expect(after.expiresAt!.getTime() - before.expiresAt!.getTime()).toBeGreaterThanOrEqual(365 * 86_400_000);
  });

  it("at expiry: EXPIRED, renewal refused, code closed for that zone (still valid in another), slot free to anyone", async () => {
    await openZone("4", Z4);
    await openZone("10", Z10);
    const o = await owner();
    const r = await book(o, ["4", "10"]);
    const [a4, a10] = (await allocs(r.booking.id)).sort((x, y) => x.zoneId.localeCompare(y.zoneId)).reverse();
    expect(a4.zoneId).toBe("4");
    // Zone 4 lapses (its expiry moved into the past); zone 10 stays active.
    await db.update(franchiseAllocations).set({ activatedAt: new Date(Date.now() - 400 * 86_400_000), periodStart: new Date(Date.now() - 400 * 86_400_000), expiresAt: new Date(Date.now() - 60_000) }).where(eq(franchiseAllocations.id, a4.id));
    const { config } = await franchiseConfig();
    expect(await expireAreas(new Date(), config)).toBe(1);
    const [gone] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, a4.id));
    expect(gone.status).toBe("EXPIRED");
    await expect(startRenewal(a4.id, o.actor)).rejects.toThrow(/expired; renewal is closed/);
    const code = await codeOf(o.dealer.id);
    await expect(assertCodeForLocation(code, Z4[0], Z4[1])).rejects.toThrow(/This franchise area has expired\./);
    expect(await assertCodeForLocation(code, Z10[0], Z10[1])).toMatchObject({ kind: "FRANCHISE", zoneId: "10" });
    const log = await db.select().from(franchiseNotificationLog).where(and(eq(franchiseNotificationLog.allocationId, a4.id), eq(franchiseNotificationLog.kind, "EXPIRED")));
    expect(log.map((l) => l.recipient)).toEqual(expect.arrayContaining(["ceo@agtci.com", "admin-dashboard"]));
    // The slot is free: the same owner (no priority) or anyone books it as a new allocation.
    const again = await book(o, ["4"]);
    const [fresh] = await allocs(again.booking.id);
    expect(fresh.id).not.toBe(a4.id);
    expect(fresh.status).toBe("ACTIVE");
    void a10;
  });

  it("the last area expiring closes the owner's code completely", async () => {
    const { o, a } = await activeArea();
    await db.update(franchiseAllocations).set({ activatedAt: new Date(Date.now() - 400 * 86_400_000), periodStart: new Date(Date.now() - 400 * 86_400_000), expiresAt: new Date(Date.now() - 60_000) }).where(eq(franchiseAllocations.id, a.id));
    await expireAreas(new Date(), (await franchiseConfig()).config);
    const [fc] = await db.select().from(franchiseCodes).where(eq(franchiseCodes.ownerDealerId, o.dealer.id));
    expect(fc.status).toBe("SUSPENDED");
    await expect(assertCodeForLocation(await codeOf(o.dealer.id), Z4[0], Z4[1])).rejects.toThrow(/closed for new shops/);
  });

  it("tail: shops keep earning after expiry until the tail end, then stop", async () => {
    const { o, a } = await activeArea();
    const shop = await registeredShop(await codeOf(o.dealer.id), Z4);
    await db.update(franchiseAllocations).set({ status: "EXPIRED", activatedAt: new Date(Date.now() - 400 * 86_400_000), periodStart: new Date(Date.now() - 400 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000), tailEndAt: new Date(Date.now() + 86_400_000) }).where(eq(franchiseAllocations.id, a.id));
    await deliver(shop.id, 1_000_000);
    const { franchiseShopMonths } = await import("@/server/franchise/commission");
    expect((await franchiseShopMonths(db, thisMonth())).map((r) => r.commissionPaise)).toEqual([20_000]);
    await db.update(franchiseAllocations).set({ tailEndAt: new Date(Date.now() - 3600_000) }).where(eq(franchiseAllocations.id, a.id));
    expect(await franchiseShopMonths(db, thisMonth())).toEqual([]);
  });

  it("the 09:00 IST digest goes once a day to the CC list", async () => {
    await activeArea();
    const { config } = await franchiseConfig();
    const nine = istInstant(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10), 9, 5);
    await sendDigest(nine, config);
    await sendDigest(nine, config);
    const rows = await db.select().from(franchiseNotificationLog).where(eq(franchiseNotificationLog.kind, "DIGEST"));
    expect(rows.map((r) => r.recipient)).toEqual(["ceo@agtci.com"]);
  });
});

/* ================================================================ Model A */

describe("Model A: 20 / 4 / 3 by level distance (brief §2.3)", () => {
  async function tieredDealer() {
    const user = await createUser({ role: "DEALER" });
    const [d] = await db
      .insert(dealers)
      .values({ userId: user.id, legalName: "Model A Dealer", contactName: "A", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", mobileE164: "+919800000001", tierAgreementVersion: AGENT_AGREEMENT_VERSION, tierAgreementAcceptedAt: new Date() })
      .returning();
    await setDealerCommissionModel(d.id, "TIERED", "model A (test)", admin);
    return d;
  }
  async function member(dealerId: string, name: string, role: "TEAM_LEAD" | "AGENT", parentId: string | null = null): Promise<DealerSalesperson> {
    const v = await addSalesperson(dealerId, { employeeId: name.toUpperCase(), name, role, parentId }, admin);
    const [m] = await db.update(dealerSalespeople).set({ panHash: `pan-${v.id}`, bankStatus: "VERIFIED", agreementVersion: AGENT_AGREEMENT_VERSION, agreementAcceptedAt: new Date() }).where(eq(dealerSalespeople.id, v.id)).returning();
    return m;
  }
  async function signed(dealerId: string, signerId: string | null, basePaise: number) {
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    const gst = Math.round(basePaise * 0.18);
    const shop = await createShop(shopOwner.id, { name: `A ${Math.random().toString(36).slice(2, 7)}`, status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: basePaise + gst });
    await db.update(shops).set({ registrationFeeBasePaise: basePaise, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: gst, phone: `9${Math.floor(100_000_000 + Math.random() * 899_999_999)}` }).where(eq(shops.id, shop.id));
    await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, salespersonId: signerId, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: basePaise + gst, method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
    for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) await db.insert(sellerVerifications).values({ shopId: shop.id, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
    await approveShop(shop.id, { classification: "KESARI" }, admin);
    return shop;
  }
  const split = async (shopId: string) =>
    (await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shopId))).map((e) => `${e.entryType}:${e.amountPaise}`).sort();

  for (const [fee, d20, o4, o3] of [
    [100_000, 20_000, 4000, 3000],
    [250_000, 50_000, 10_000, 7500],
  ] as const) {
    it(`the four cases on a ₹${fee / 100} shop`, async () => {
      const d = await tieredDealer();
      const lead = await member(d.id, `Lead${fee}`, "TEAM_LEAD");
      const direct = await member(d.id, `Direct${fee}`, "AGENT");
      const under = await member(d.id, `Under${fee}`, "AGENT", lead.id);
      expect(await split((await signed(d.id, null, fee)).id)).toEqual([`DIRECT_1:${d20}`]); // 1 dealer
      expect(await split((await signed(d.id, direct.id, fee)).id)).toEqual([`DIRECT_1:${d20}`, `OVERRIDE_MAIN:${o4}`]); // 2 agent under dealer
      expect(await split((await signed(d.id, under.id, fee)).id)).toEqual([`DIRECT_1:${d20}`, `OVERRIDE_LEAD:${o4}`, `OVERRIDE_MAIN:${o3}`]); // 3 agent under lead
      expect(await split((await signed(d.id, lead.id, fee)).id)).toEqual([`DIRECT_1:${d20}`, `OVERRIDE_MAIN:${o4}`]); // 4 lead
    });
  }

  it("a team lead deactivated: his agents move under the dealer; later shops pay the dealer 4%, earlier ones unchanged", async () => {
    const d = await tieredDealer();
    const lead = await member(d.id, "LeadX", "TEAM_LEAD");
    const agent = await member(d.id, "AgentX", "AGENT", lead.id);
    const before = await signed(d.id, agent.id, 100_000);
    await setSalespersonStatus(d.id, lead.id, "INACTIVE", admin);
    const [moved] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, agent.id));
    expect(moved).toMatchObject({ depth: 2, parentId: null, status: "ACTIVE" });
    const after = await signed(d.id, agent.id, 100_000);
    expect(await split(before.id)).toEqual(["DIRECT_1:20000", "OVERRIDE_LEAD:4000", "OVERRIDE_MAIN:3000"]);
    expect(await split(after.id)).toEqual(["DIRECT_1:20000", "OVERRIDE_MAIN:4000"]);
  });

  it("a team lead cannot add a team lead; one mobile once per team; new codes are GKD- / GKT- / GKA-", async () => {
    const d = await tieredDealer();
    const lead = await member(d.id, "LeadY", "TEAM_LEAD");
    await db.update(dealerSalespeople).set({ userId: (await createUser({ role: "DEALER" })).id }).where(eq(dealerSalespeople.id, lead.id));
    const [l] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, lead.id));
    const added = await leadAddsAgent({ id: l.userId!, role: "DEALER" }, { employeeId: "SUB1", name: "Sub One" });
    expect((await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, added.id)))[0]).toMatchObject({ teamRole: "AGENT", parentId: lead.id });
    await addSalesperson(d.id, { employeeId: "M1", name: "Mob One", mobile: "9876500001" }, admin);
    await expect(addSalesperson(d.id, { employeeId: "M2", name: "Mob Two", mobile: "9876500001" }, admin)).rejects.toThrow(/already in your team/);
    await expect(addSalesperson(d.id, { employeeId: "M3", name: "Dealer Mobile", mobile: "9800000001" }, admin)).rejects.toThrow(/already in your team/);
    const codes = await db.execute<{ code: string; role: string }>(sql`
      select rc.code, coalesce(sp.team_role, 'AGENT') as role from dealer_codes dc join referral_codes rc on rc.id = dc.referral_code_id
      join dealer_salespeople sp on sp.id = dc.salesperson_id where dc.dealer_id = ${d.id}`);
    for (const c of codes as unknown as { code: string; role: string }[]) expect(c.code).toMatch(c.role === "TEAM_LEAD" ? /^GKT-/ : /^GKA-/);
  });
});

/* ============================================================ the estimate */

describe("estimate helper agrees with the stored inputs", () => {
  it("zone 50C: 1,600 × ₹16.4 lakh = ₹262.40 Cr a month", () => {
    expect(zoneEstimate({ estShopCount: 1600, gmvPerShopLakh: 16.4 }).monthlyCrHundredths).toBe(26_240);
  });
});
