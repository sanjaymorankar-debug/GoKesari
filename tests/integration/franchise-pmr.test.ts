/**
 * Franchise module — owner's final brief 21-Nov-2026 08.06 IST (docs/franchise/), against real PostgreSQL.
 * §11 minimum tests, as far as they run without a browser or a payment gateway:
 *   zones and areas (50 zones, 189 mapped, 7 unzoned, short names) · seed fees and tiers · import → preview → publish
 *   zone status (each status, Sold Out automatic, Reserved expiry, Inactive, scheduled change, logged and told)
 *   booking (multi-zone cart, third franchise blocked, 2 slots under a race, 15-minute hold, provisional sale switch)
 *   coupons (%, cap, flat split, scope, private, limits, minimum, first purchase, launch only, renewal only, GST on
 *   the discounted amount, released on failure and refund, rejection messages, commission unaffected)
 *   the 8 cases A1–A4 / B1–B4 on ₹1,000 and ₹2,500 · parity · free team in a paid zone (no owner override, attached
 *   for recurring, 2-owner split, attaches to a later franchise) · recurring 20% of 2% · upgrade Free → Paid
 *   tail and transfer of free-team shops · reminders with the renewal fee · month lock, statement · Model A team rules
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AGENT_AGREEMENT_VERSION } from "@/lib/dealer-tiers";
import { FRANCHISE_AGREEMENT_VERSION, istMonthBounds } from "@/lib/franchise";
import { db } from "@/server/db";
import {
  dealerCodes,
  dealerCommissionLedger,
  dealerCommissionMonths,
  dealerSalespeople,
  dealerTierShopPlans,
  dealers,
  financialAdjustments,
  franchiseAllocations,
  franchiseAreas,
  franchiseBookings,
  franchiseCalcRuns,
  franchiseCampaigns,
  franchiseConfigVersions,
  franchiseCouponAssignments,
  franchiseCouponRedemptions,
  franchiseCoupons,
  franchiseMonthlySnapshots,
  franchiseNotificationLog,
  franchiseShopAttributions,
  franchiseShopTeamPeriods,
  franchiseZoneBoundaries,
  franchiseZoneBusiness,
  franchiseZoneFeeVersions,
  franchiseZoneStatusHistory,
  franchiseZones,
  orders,
  referralCodes,
  sellerVerifications,
  shopAttributions,
  shops,
  type DealerSalesperson,
} from "@/server/db/schema";
import { reverseShopCommission, setCommissionSettings } from "@/server/dealers/commission";
import { addMoveDocument, cancelMoveRequest, createMoveRequest, decideMoveRequest, missingDocuments } from "@/server/dealers/referral-moves";
import { addSalesperson, setSalespersonStatus, transferMemberToDealer } from "@/server/dealers/service";
import { leadAddsAgent, setDealerCommissionModel } from "@/server/dealers/tiered";
import { acceptFranchiseAgreement, cancelReservation, onFranchiseFeeCaptured, onFranchiseFeeEnded, refundBooking, releaseExpiredHolds, reserveZones, setAllocationStatus, startRenewal } from "@/server/franchise/booking";
import { assertFranchiseCodeOpen } from "@/server/franchise/codes";
import { calculateAllocationMonth, calculateFranchiseMonth, lockFranchiseMonth, prevMonth } from "@/server/franchise/commission";
import { createCoupon, type CouponInput } from "@/server/franchise/coupons";
import { franchiseConfig, saveFranchiseConfig } from "@/server/franchise/config";
import { expireAreas, sendReminders } from "@/server/franchise/jobs";
import { emailStatements, statementData, statementPdf } from "@/server/franchise/statements";
import { changeZoneStatus, correctShopArea, importZoneBusiness, listAreas, publishFees, remapArea, runZoneStatusJobs, setShopArea, setZoneMaxOwners, suggestAreas, zoneView, zoneViews } from "@/server/franchise/zones";
import type { PaymentIntentRow } from "@/server/db/schema";
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

/** Zones used below (seed fees): 03 Shivajinagar–Deccan Premier ₹2,26,000; 07 Karve Nagar–Erandwane Standard ₹1,50,000; 47 Pirangut–Mulshi Emerging ₹75,000. */
const Z3 = "GKZ-PUN-03";
const Z7 = "GKZ-PUN-07";
const Z47 = "GKZ-PUN-47";
const AREA: Record<string, string> = { [Z3]: "Shivajinagar", [Z7]: "Karve Nagar", [Z47]: "Pirangut" };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  await db.delete(franchiseNotificationLog);
  await db.delete(franchiseCalcRuns);
  await db.delete(franchiseMonthlySnapshots);
  await db.delete(franchiseShopTeamPeriods);
  await db.delete(franchiseCouponRedemptions);
  await db.delete(franchiseCouponAssignments);
  await db.delete(franchiseCoupons);
  await db.delete(franchiseZoneBoundaries);
  await db.delete(franchiseAreas).where(eq(franchiseAreas.isTest, true));
  await db.delete(franchiseZoneStatusHistory).where(sql`${franchiseZoneStatusHistory.reason} not like 'Zone created%'`);
  await db.delete(franchiseZoneFeeVersions).where(sql`not ${franchiseZoneFeeVersions.provisional} or ${franchiseZoneFeeVersions.zoneId} like 'T-%'`);
  await db.update(franchiseZoneFeeVersions).set({ supersededAt: null });
  await db.delete(franchiseZoneBusiness).where(sql`not ${franchiseZoneBusiness.provisional}`); // the seed rows (all sets) are provisional
  await db.update(franchiseZoneBusiness).set({ status: "PUBLISHED" }).where(sql`${franchiseZoneBusiness.provisional}`);
  await db.delete(franchiseZones).where(eq(franchiseZones.isTest, true));
  // Every zone on sale for the tests (the real default is Coming Soon until an admin opens them).
  await db.update(franchiseZones).set({ status: "AVAILABLE", statusReason: null, reservedForDealerId: null, reservedUntil: null, maxOwners: 2 });
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
  // Most cases test the regular (tier) fees; the launch-offer fee has its own case below.
  await saveFranchiseConfig({ bookingOpen: true, allowProvisionalSale: true, promoFeePaise: null }, { reason: "open for the tests" }, admin);
});

/* ================================================================ helpers */

async function areaId(name: string): Promise<string> {
  const [a] = await db.select({ id: franchiseAreas.id }).from(franchiseAreas).where(eq(franchiseAreas.name, name));
  return a.id;
}

/** An approved dealer (TIERED) with PAN and a verified bank who accepted the franchise rules. */
async function dealer(name = `Dealer ${Math.random().toString(36).slice(2, 6)}`) {
  const user = await createUser({ role: "DEALER" });
  const [d] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, bankStatus: "VERIFIED", tierAgreementVersion: AGENT_AGREEMENT_VERSION, tierAgreementAcceptedAt: new Date() })
    .returning();
  await setDealerCommissionModel(d.id, "TIERED", "model A team (test)", admin);
  const actor = { id: user.id, role: "DEALER" as const };
  await acceptFranchiseAgreement(actor, FRANCHISE_AGREEMENT_VERSION, { ipAddress: "127.0.0.1", userAgent: "vitest" });
  return { dealer: d, actor, user };
}
type Owner = Awaited<ReturnType<typeof dealer>>;

async function member(dealerId: string, name: string, role: "TEAM_LEAD" | "AGENT", parentId: string | null = null): Promise<DealerSalesperson> {
  const v = await addSalesperson(dealerId, { employeeId: name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12), name, role, parentId }, admin);
  const [m] = await db.update(dealerSalespeople).set({ panHash: `pan-${v.id}`, bankStatus: "VERIFIED", agreementVersion: AGENT_AGREEMENT_VERSION, agreementAcceptedAt: new Date() }).where(eq(dealerSalespeople.id, v.id)).returning();
  return m;
}

async function capture(bookingId: string) {
  const [b] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  const intent = { id: b.paymentIntentId ?? randomUUID(), purpose: "FRANCHISE_FEE", referenceId: b.id, userId: null, amountPaise: Number(b.totalPaise), refundedPaise: 0, status: "CAPTURED", gateway: "SANDBOX", gatewayOrderId: null, gatewayPaymentId: null } as unknown as PaymentIntentRef;
  // As the payment purpose handlers do: notices and the Sold Out check run after the commit.
  const after: (() => Promise<void>)[] = [];
  await db.transaction((tx) => onFranchiseFeeCaptured(intent, tx, (task) => after.push(task)));
  for (const task of after) await task();
}

async function book(o: Owner, zoneIds: string[], couponCode?: string) {
  const r = await reserveZones(o.actor, { zoneIds, couponCode });
  await capture(r.booking.id);
  return r;
}

const allocs = (bookingId: string) => db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, bookingId));

/** A shop in `areaName` registered by `dealerId` (signer: a member or the dealer), fee paid (base + 18%), approved. */
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

/** "TYPE:payee:amount" for every ledger entry of a shop (payee: member name, or OWNER). */
async function split(shopId: string): Promise<string[]> {
  const rows = await db.select({ e: dealerCommissionLedger, name: dealerSalespeople.name }).from(dealerCommissionLedger).leftJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerCommissionLedger.payeeMemberId)).where(eq(dealerCommissionLedger.shopId, shopId));
  return rows.map((r) => `${r.e.entryType}:${r.name ?? "TOP"}:${r.e.amountPaise}`).sort();
}

const thisMonth = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 7);

const coupon = (over: Partial<CouponInput> = {}): CouponInput => ({
  code: `C${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  name: "Test coupon",
  discountType: "PERCENT",
  percentBp: 1000,
  scope: { all: true },
  appliesOn: "BOTH",
  visibility: "PUBLIC",
  startsAt: new Date(Date.now() - 3_600_000),
  endsAt: new Date(Date.now() + 30 * 86_400_000),
  ...over,
});

/* ================================================================ zones and areas (§5.1) */

describe("zones and the area master (§5.1)", () => {
  it("50 zones GKZ-PUN-01…50 with cluster, region and civic body; 189 areas mapped to exactly one zone; 7 unzoned", async () => {
    const all = await zoneViews();
    const zones = all.filter((z) => z.zoneSetCode === "PUN");
    expect(zones).toHaveLength(50);
    // Owner, 21-Nov-2026 09.20 IST: Mumbai (Konkan) and Nashik zone sets are on sale too.
    expect(all.filter((z) => z.zoneSetCode === "MUM")).toHaveLength(38);
    expect(all.filter((z) => z.zoneSetCode === "NSK")).toHaveLength(11);
    expect(zones.map((z) => z.zoneId)).toEqual(Array.from({ length: 50 }, (_, i) => `GKZ-PUN-${String(i + 1).padStart(2, "0")}`));
    expect(zones[1]).toMatchObject({ clusterNo: 2, name: "Peth East", region: "Central", civicBody: "PMC" });
    const areas = await listAreas({ zoneSetCode: "PUN" });
    expect(areas).toHaveLength(196);
    expect(areas.filter((a) => a.zoneId)).toHaveLength(189);
    expect(areas.filter((a) => !a.zoneId).map((a) => a.name).sort()).toEqual(["Koregaon Bhima", "Khed Shivapur", "Rajgurunagar (Khed)", "Ranjangaon", "Sanaswadi", "Saswad", "Shikrapur"].sort());
  });

  it("short cluster names map to the full area names", async () => {
    const byName = new Map((await listAreas()).map((a) => [a.name, a.zoneId]));
    expect(byName.get("Budhwar Peth")).toBe("GKZ-PUN-02");
    expect(byName.get("Ghorpade Peth")).toBe("GKZ-PUN-02");
    expect(byName.get("Ganj Peth (Mahatma Phule Peth)")).toBe("GKZ-PUN-02");
    expect(byName.get("Camp (Pune Cantonment)")).toBe("GKZ-PUN-05");
    expect(byName.get("Ganeshkhind (University area)")).toBe("GKZ-PUN-11");
    expect(byName.get("Lohegaon")).toBe("GKZ-PUN-15");
    expect(byName.get("Pradhikaran (Nigdi)")).toBe("GKZ-PUN-37");
  });

  it("registration suggests areas by PIN code first, then by distance; the user's choice decides the zone", async () => {
    const s = await suggestAreas({ pincode: "411038", lat: 18.5074, lng: 73.8077 });
    expect(s[0]).toMatchObject({ name: "Kothrud", zoneId: "GKZ-PUN-06", pinMatch: true });
    const near = await suggestAreas({ lat: 18.5913, lng: 73.7389 });
    expect(near[0].name).toBe("Hinjewadi");
  });

  it("an admin / operator corrects a shop's area: audited, and only later commission follows the new zone", async () => {
    const o = await dealer();
    const shop = await signed(o.dealer.id, null, 100_000, AREA[Z3]);
    const operator = await createUser({ role: "OPERATOR" });
    const zone = await correctShopArea(shop.id, await areaId("Karve Nagar"), "pin was on the wrong road", { id: operator.id, role: "OPERATOR" });
    expect(zone).toBe(Z7);
    const periods = await db.execute<{ zone_id: string; valid_to: Date | null }>(sql`select zone_id, valid_to from franchise_shop_area_periods where shop_id = ${shop.id} order by valid_from`);
    expect((periods as unknown as { zone_id: string; valid_to: Date | null }[]).map((p) => [p.zone_id, p.valid_to === null])).toEqual([
      [Z3, false],
      [Z7, true],
    ]);
  });

  it("an area moved to another zone (or Unzoned) is audited and its shops get a new period from now", async () => {
    const o = await dealer();
    const shop = await signed(o.dealer.id, null, 100_000, "Hingne Khurd");
    const id = await areaId("Hingne Khurd");
    await remapArea(id, null, "boundary review (test)", admin);
    const [now] = (await db.execute(sql`select zone_id from franchise_shop_area_periods where shop_id = ${shop.id} and valid_to is null`)) as unknown as { zone_id: string | null }[];
    expect(now.zone_id).toBeNull();
    await remapArea(id, Z7, "back (test)", admin);
  });
});

/* ================================================================ tiers and fees (§5.2, §5.3) */

describe("tiers and fees", () => {
  it("the seed reproduces every fee and tier of the brief's table: 20 Premier, 12 Standard, 18 Emerging, all provisional", async () => {
    const zones = (await zoneViews()).filter((z) => z.zoneSetCode === "PUN");
    const count = (t: string) => zones.filter((z) => z.tier === t).length;
    expect([count("PREMIER"), count("STANDARD"), count("EMERGING")]).toEqual([20, 12, 18]);
    expect(zones.every((z) => z.provisional)).toBe(true);
    const fee = (id: string) => zones.find((z) => z.zoneId === id)!.feePaise! / 100;
    expect([fee("GKZ-PUN-02"), fee("GKZ-PUN-03"), fee(Z7), fee("GKZ-PUN-23"), fee("GKZ-PUN-27"), fee(Z47), fee("GKZ-PUN-50")]).toEqual([226_000, 226_000, 150_000, 98_000, 91_000, 75_000, 83_000]);
    const z2 = zones.find((z) => z.zoneId === "GKZ-PUN-02")!;
    expect(z2.description).toBe("Premier zone – business about 51% above the Pune zone average. Wholesale trade peths (Raviwar, Budhwar, Ganj). Annual franchise fee ₹2,26,000 + GST.");
    expect(zones.find((z) => z.zoneId === "GKZ-PUN-31")!.description).toMatch(/^Emerging zone – business about 30% below the Pune zone average\. .*room to grow\. Annual franchise fee ₹1,06,000 \+ GST\.$/);
  });

  it("launch offer (owner, 21-Nov 09.20 IST): every zone at ₹1,50,000 with its regular rate beside it; sold even while the regular rate is provisional; locked for the term", async () => {
    await saveFranchiseConfig({ promoFeePaise: 15_000_000, allowProvisionalSale: false }, { reason: "launch offer (test)" }, admin);
    const z = await zoneView("GKZ-PUN-02");
    expect(z).toMatchObject({ feePaise: 15_000_000, promoFeePaise: 15_000_000, regularFeePaise: 22_600_000, provisional: true, forSale: true });
    expect(z.description).toMatch(/Launch offer ₹1,50,000 \+ GST a year for the first 25 franchise dealers \(regular annual fee ₹2,26,000 \+ GST\)/);
    expect((await zoneView("GKZ-MUM-09")).feePaise).toBe(15_000_000);
    const o = await dealer();
    const r = await book(o, ["GKZ-PUN-02", "GKZ-NSK-02"]);
    expect(r.booking).toMatchObject({ listPaise: 30_000_000, launchOffer: true });
    expect((await allocs(r.booking.id)).map((a) => Number(a.feePaise))).toEqual([15_000_000, 15_000_000]);
    // Once the launch offer closes, the regular rate applies.
    await db.update(franchiseCampaigns).set({ closedAt: new Date() });
    expect((await zoneView("GKZ-PUN-02")).feePaise).toBe(22_600_000);
  });

  it("checkout is disabled with 'Fees being finalised' while the provisional-sale switch is off", async () => {
    await saveFranchiseConfig({ allowProvisionalSale: false }, { reason: "final fees first" }, admin);
    const o = await dealer();
    await expect(reserveZones(o.actor, { zoneIds: [Z7] })).rejects.toThrow(/fees being finalised/);
    expect((await zoneView(Z7)).forSale).toBe(false);
  });

  it("import → preview → publish: new tiers and fees for new bookings; an active franchise keeps its fee; renewal uses the new one", async () => {
    const o = await dealer();
    const r = await book(o, [Z7]);
    const zones = (await zoneViews({ includeInactive: true })).filter((z) => z.zoneSetCode === "PUN");
    // Actual business: zone 07 now 2× everyone else's (₹200 Cr vs ₹100 Cr).
    const csv = ["zone code,annual business (₹ Cr),source,as of", ...zones.map((z) => `${z.zoneId},${z.zoneId === Z7 ? 200 : 100},GST data (test),2026-11-20`)].join("\n");
    await expect(importZoneBusiness(csv.split("\n").slice(0, 10).join("\n"), admin)).rejects.toThrow(/must cover every active zone/);
    const preview = await importZoneBusiness(csv, admin);
    const row = preview.rows.find((x) => x.zoneId === Z7)!;
    expect(row).toMatchObject({ oldTier: "STANDARD", oldFeePaise: 15_000_000, newTier: "PREMIER", newDiffBp: 9608, newFeePaise: 29_400_000, changed: true });
    expect(preview.counts).toEqual({ PREMIER: 1, STANDARD: 49, EMERGING: 0 }); // the others are 2% below the new average: Standard
    await publishFees("PUN", preview.batchId, "actual GST data (test)", admin);
    const z7 = await zoneView(Z7);
    expect(z7).toMatchObject({ tier: "PREMIER", feePaise: 29_400_000, provisional: false, source: "GST data (test)" });
    const [a] = await allocs(r.booking.id);
    expect(Number(a.feePaise)).toBe(15_000_000); // locked for the term
    await db.update(franchiseAllocations).set({ expiresAt: new Date(Date.now() + 10 * 86_400_000) }).where(eq(franchiseAllocations.id, a.id));
    await startRenewal(a.id, o.actor).catch(() => null); // the gateway is not reachable in tests; the booking is made first
    const [renewal] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.renewalAllocationId, a.id));
    expect(Number(renewal.listPaise)).toBe(29_400_000);
  });
});

/* ================================================================ zone status (§5.6) */

describe("zone status — Admin control", () => {
  it("Coming Soon and On Hold cannot be bought; Inactive is hidden; every change needs a reason and is logged", async () => {
    const o = await dealer();
    await expect(changeZoneStatus([Z3], { status: "ON_HOLD", reason: "no" }, admin)).rejects.toThrow(/reason/);
    await changeZoneStatus([Z3, Z7], { status: "COMING_SOON", reason: "launch next week" }, admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z3] })).rejects.toThrow(/coming soon/);
    await changeZoneStatus([Z3], { status: "ON_HOLD", reason: "data review" }, admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z3] })).rejects.toThrow(/on hold/);
    await changeZoneStatus([Z3], { status: "INACTIVE", reason: "zone withdrawn (test)" }, admin);
    expect((await zoneViews()).some((z) => z.zoneId === Z3)).toBe(false);
    const h = await db.select().from(franchiseZoneStatusHistory).where(and(eq(franchiseZoneStatusHistory.zoneId, Z3), sql`${franchiseZoneStatusHistory.changedBy} is not null`));
    expect(h.map((x) => [x.oldStatus, x.newStatus])).toEqual(expect.arrayContaining([["AVAILABLE", "COMING_SOON"], ["COMING_SOON", "ON_HOLD"], ["ON_HOLD", "INACTIVE"]]));
    await expect(changeZoneStatus([Z3], { status: "SOLD_OUT", reason: "manual sold out" }, admin)).rejects.toThrow(/system/);
  });

  it("Reserved: only the named dealer can buy until the expiry, then it is Available again automatically", async () => {
    const x = await dealer("Reserved for");
    const y = await dealer("Someone else");
    const until = new Date(Date.now() + 2 * 86_400_000);
    await changeZoneStatus([Z7], { status: "RESERVED", reason: "promised at the meeting", reservedForDealerId: x.dealer.id, reservedUntil: until }, admin);
    await expect(reserveZones(y.actor, { zoneIds: [Z7] })).rejects.toThrow(/reserved for another dealer/);
    await runZoneStatusJobs(new Date(until.getTime() + 60_000));
    expect((await zoneView(Z7)).status).toBe("AVAILABLE");
    await changeZoneStatus([Z3], { status: "RESERVED", reason: "promised", reservedForDealerId: x.dealer.id, reservedUntil: until }, admin);
    await book(x, [Z3]);
    expect((await zoneView(Z3)).status).toBe("AVAILABLE");
  });

  it("Sold Out is set when 2 franchises are active and cleared when a slot frees; max franchises never below the active count", async () => {
    const a = await dealer();
    const b = await dealer();
    await book(a, [Z7]);
    const rb = await book(b, [Z7]);
    const v = await zoneView(Z7);
    expect([v.status, v.badge, v.slotsFree]).toEqual(["SOLD_OUT", "SOLD_OUT", 0]);
    await expect(setZoneMaxOwners(Z7, 1, "one only", admin)).rejects.toThrow(/cannot go below/);
    const [ab] = await allocs(rb.booking.id);
    await setAllocationStatus(ab.id, "TERMINATED", "breach (test)", admin);
    expect((await zoneView(Z7)).status).toBe("AVAILABLE");
    const log = await db.select().from(franchiseNotificationLog).where(sql`${franchiseNotificationLog.kind} like ${`ZONE_STATUS:${Z7}:%`}`);
    expect(log.some((l) => l.recipient === "ceo@agtci.com")).toBe(true);
  });

  it("a change scheduled for a future IST time is applied by the job at that time, not before", async () => {
    const at = new Date(Date.now() + 3 * 3_600_000);
    const r = await changeZoneStatus([Z47], { status: "COMING_SOON", reason: "launch day switch", scheduledFor: at }, admin);
    expect(r).toEqual({ applied: [], scheduled: [Z47] });
    await runZoneStatusJobs(new Date(at.getTime() - 60_000));
    expect((await zoneView(Z47)).status).toBe("AVAILABLE");
    await runZoneStatusJobs(new Date(at.getTime() + 60_000));
    expect((await zoneView(Z47)).status).toBe("COMING_SOON");
  });

  it("Inactive: the running term continues, renewal is blocked and the owner is told before expiry", async () => {
    const o = await dealer();
    const r = await book(o, [Z7]);
    const [a] = await allocs(r.booking.id);
    await changeZoneStatus([Z7], { status: "INACTIVE", reason: "zone withdrawn (test)" }, admin);
    expect((await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, a.id)))[0].status).toBe("ACTIVE");
    const noon = new Date();
    noon.setUTCHours(6, 0, 0, 0); // 11.30 IST
    await db.update(franchiseAllocations).set({ expiresAt: new Date(noon.getTime() + 20 * 86_400_000) }).where(eq(franchiseAllocations.id, a.id));
    await expect(startRenewal(a.id, o.actor)).rejects.toThrow(/inactive: renewal is closed/);
    const { config } = await franchiseConfig();
    await sendReminders(noon, config);
    const log = await db.select().from(franchiseNotificationLog).where(and(eq(franchiseNotificationLog.allocationId, a.id), eq(franchiseNotificationLog.kind, "INACTIVE_NOTICE")));
    expect(log.map((l) => l.recipient)).toEqual(expect.arrayContaining(["ceo@agtci.com"]));
  });
});

/* ================================================================ booking (§5.5) */

describe("booking", () => {
  it("a multi-zone cart is all-or-nothing; the third franchise in a zone is refused", async () => {
    const a = await dealer();
    const b = await dealer();
    const c = await dealer();
    await book(a, [Z7]);
    await book(b, [Z7]);
    await expect(reserveZones(c.actor, { zoneIds: [Z3, Z7] })).rejects.toThrow(/Nothing was reserved: .*GKZ-PUN-07/);
    expect(await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.ownerDealerId, c.dealer.id))).toHaveLength(0);
    const ok = await book(c, [Z3, Z47]);
    expect(ok.booking).toMatchObject({ areaCount: 2, listPaise: 22_600_000 + 7_500_000, discountPaise: 0, basePaise: 30_100_000, gstPaise: 5_418_000, totalPaise: 35_518_000 });
  });

  it("10 dealers racing for one zone: exactly 2 slots are taken", async () => {
    const owners = await Promise.all(Array.from({ length: 10 }, () => dealer()));
    const results = await Promise.allSettled(owners.map((o) => reserveZones(o.actor, { zoneIds: [Z3] })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });

  it("the 15-minute hold: released when it runs out or the payment fails; the coupon use is released with it", async () => {
    const o = await dealer();
    const c = await createCoupon(coupon({ totalLimit: 1 }), admin);
    const r = await reserveZones(o.actor, { zoneIds: [Z7], couponCode: c.code });
    expect(r.booking.discountPaise).toBe(1_500_000);
    await releaseExpiredHolds(db, new Date(Date.now() + 16 * 60_000));
    expect((await allocs(r.booking.id))[0].status).toBe("RESERVATION_EXPIRED");
    const [red] = await db.select().from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.bookingId, r.booking.id));
    expect(red.status).toBe("RELEASED");
    const r2 = await reserveZones(o.actor, { zoneIds: [Z7], couponCode: c.code }); // the single use is free again
    const intent = { id: randomUUID(), purpose: "FRANCHISE_FEE", referenceId: r2.booking.id, status: "FAILED" } as unknown as PaymentIntentRow;
    await db.transaction((tx) => onFranchiseFeeEnded(intent, "FAILED", tx));
    expect((await db.select().from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.bookingId, r2.booking.id)))[0].status).toBe("RELEASED");
    await cancelReservation((await reserveZones(o.actor, { zoneIds: [Z3] })).booking.id, o.actor);
  });
});

/* ================================================================ coupons (§5.7) */

describe("coupons on franchise fees", () => {
  it("% coupon with a cap; GST on the discounted amount; the list fee stays locked; one use counted only after payment", async () => {
    const o = await dealer();
    const c = await createCoupon(coupon({ percentBp: 2000, maxDiscountPaise: 3_000_000 }), admin);
    const r = await reserveZones(o.actor, { zoneIds: [Z3, Z7], couponCode: c.code.toLowerCase() });
    // 20% of ₹2,26,000 + ₹1,50,000 = ₹75,200, capped at ₹30,000, shared in proportion to the fees.
    expect(r.booking).toMatchObject({ listPaise: 37_600_000, discountPaise: 3_000_000, basePaise: 34_600_000, gstPaise: 6_228_000, totalPaise: 40_828_000, couponCode: c.code });
    const parts = (await allocs(r.booking.id)).sort((x, y) => x.zoneId.localeCompare(y.zoneId)).map((a) => [a.zoneId, Number(a.feePaise), Number(a.discountPaise)]);
    expect(parts).toEqual([
      [Z3, 22_600_000, 1_803_192],
      [Z7, 15_000_000, 1_196_808],
    ]);
    expect((await db.select().from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.bookingId, r.booking.id)))[0].status).toBe("HELD");
    await capture(r.booking.id);
    expect((await db.select().from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.bookingId, r.booking.id)))[0].status).toBe("USED");
  });

  it("flat coupon split in proportion over the eligible zones only (scope by tier); never below ₹1", async () => {
    const o = await dealer();
    const c = await createCoupon(coupon({ discountType: "FLAT", percentBp: null, flatPaise: 5_000_000, scope: { tiers: ["EMERGING"] } }), admin);
    const r = await reserveZones(o.actor, { zoneIds: [Z7, Z47], couponCode: c.code });
    const parts = (await allocs(r.booking.id)).sort((x, y) => x.zoneId.localeCompare(y.zoneId)).map((a) => [a.zoneId, Number(a.discountPaise)]);
    expect(parts).toEqual([
      [Z7, 0],
      [Z47, 5_000_000],
    ]);
    const big = await createCoupon(coupon({ discountType: "FLAT", percentBp: null, flatPaise: 100_000_000, scope: { zones: [Z47] } }), admin);
    const o2 = await dealer();
    const r2 = await reserveZones(o2.actor, { zoneIds: [Z47], couponCode: big.code });
    expect(Number(r2.booking.basePaise)).toBe(100); // ₹1
  });

  it("rejections with clear reasons: unknown, paused, expired, wrong zone, private, limits, minimum, first purchase, launch only, renewal only", async () => {
    const o = await dealer();
    const other = await dealer();
    await expect(reserveZones(o.actor, { zoneIds: [Z7], couponCode: "NOPE99" })).rejects.toThrow(/does not exist/);
    const paused = await createCoupon(coupon({ code: "PAUSED1" }), admin);
    await db.update(franchiseCoupons).set({ status: "PAUSED" }).where(eq(franchiseCoupons.id, paused.id));
    await expect(reserveZones(o.actor, { zoneIds: [Z7], couponCode: "PAUSED1" })).rejects.toThrow(/paused/);
    await createCoupon(coupon({ code: "OLD1", startsAt: new Date(Date.now() - 10 * 86_400_000), endsAt: new Date(Date.now() - 86_400_000) }), admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z7], couponCode: "OLD1" })).rejects.toThrow(/expired/);
    await createCoupon(coupon({ code: "PREM1", scope: { tiers: ["PREMIER"] } }), admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z7], couponCode: "PREM1" })).rejects.toThrow(/not valid for this zone/);
    const priv = await createCoupon(coupon({ code: "PRIV1", visibility: "PRIVATE" }), admin);
    await db.insert(franchiseCouponAssignments).values({ couponId: priv.id, dealerId: other.dealer.id });
    await expect(reserveZones(o.actor, { zoneIds: [Z7], couponCode: "PRIV1" })).rejects.toThrow(/not assigned to you/);
    await createCoupon(coupon({ code: "MIN1", minCartPaise: 20_000_000 }), admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z7], couponCode: "MIN1" })).rejects.toThrow(/at least ₹2,00,000/);
    await createCoupon(coupon({ code: "RENEW1", appliesOn: "RENEWAL" }), admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z7], couponCode: "RENEW1" })).rejects.toThrow(/renewals only/);
    await createCoupon(coupon({ code: "ONCE1", perDealerLimit: 1 }), admin);
    await book(o, [Z7], "ONCE1");
    await expect(reserveZones(o.actor, { zoneIds: [Z3], couponCode: "ONCE1" })).rejects.toThrow(/most times allowed/);
    await createCoupon(coupon({ code: "FIRST1", firstPurchaseOnly: true }), admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z3], couponCode: "FIRST1" })).rejects.toThrow(/first franchise purchase/);
    await createCoupon(coupon({ code: "TOTAL1", totalLimit: 1 }), admin);
    await book(other, [Z3], "TOTAL1");
    await expect(reserveZones(o.actor, { zoneIds: [Z3], couponCode: "TOTAL1" })).rejects.toThrow(/limit of uses/);
    await saveFranchiseConfig({ launchMaxOwners: 2, launchMaxAreas: 2 }, { reason: "small launch (test)" }, admin);
    await createCoupon(coupon({ code: "LAUNCH1", launchOnly: true }), admin);
    const late = await dealer();
    await expect(reserveZones(late.actor, { zoneIds: [Z47], couponCode: "LAUNCH1" })).rejects.toThrow(/Launch offer closed/);
  });

  it("a fully refunded booking releases its coupon use, voids the franchise and frees the slot", async () => {
    const o = await dealer();
    const c = await createCoupon(coupon({ totalLimit: 1 }), admin);
    const r = await book(o, [Z7], c.code);
    await refundBooking(r.booking.id, "owner withdrew (test)", admin);
    expect((await db.select().from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.bookingId, r.booking.id)))[0].status).toBe("RELEASED");
    expect((await allocs(r.booking.id))[0].status).toBe("CANCELLED");
    expect((await zoneView(Z7)).slotsFree).toBe(2);
  });
});

/* ================================================================ one-time commission (§3) */

describe("one-time commission: cases A1–A4 and B1–B4, GoKesari pays everyone directly", () => {
  for (const [fee, a, tl, d4, d3, own25] of [
    [100_000, 20_000, 4000, 4000, 3000, 25_000],
    [250_000, 50_000, 10_000, 10_000, 7500, 62_500],
  ] as const) {
    it(`₹${(fee / 100).toLocaleString("en-IN")} shop: amounts exactly as §3.3`, async () => {
      // Model A: a free dealer and his team, shops anywhere.
      const d = await dealer("Free");
      const lead = await member(d.dealer.id, `Lead ${fee}`, "TEAM_LEAD");
      const direct = await member(d.dealer.id, `Direct ${fee}`, "AGENT");
      const under = await member(d.dealer.id, `Under ${fee}`, "AGENT", lead.id);
      expect(await split((await signed(d.dealer.id, null, fee, AREA[Z47])).id)).toEqual([`DIRECT_1:TOP:${a}`]); // A1
      expect(await split((await signed(d.dealer.id, direct.id, fee, AREA[Z47])).id)).toEqual([`DIRECT_1:${direct.name}:${a}`, `OVERRIDE_MAIN:TOP:${d4}`].sort()); // A2
      expect(await split((await signed(d.dealer.id, under.id, fee, AREA[Z47])).id)).toEqual([`DIRECT_1:${under.name}:${a}`, `OVERRIDE_LEAD:${lead.name}:${tl}`, `OVERRIDE_MAIN:TOP:${d3}`].sort()); // A3
      expect(await split((await signed(d.dealer.id, lead.id, fee, AREA[Z47])).id)).toEqual([`DIRECT_1:${lead.name}:${a}`, `OVERRIDE_MAIN:TOP:${d4}`].sort()); // A4
      // Model B: a franchise owner and his team, shops inside his paid zone.
      const o = await dealer("Owner");
      await book(o, [Z3]);
      const olead = await member(o.dealer.id, `OLead ${fee}`, "TEAM_LEAD");
      const odirect = await member(o.dealer.id, `ODirect ${fee}`, "AGENT");
      const ounder = await member(o.dealer.id, `OUnder ${fee}`, "AGENT", olead.id);
      const b1 = await signed(o.dealer.id, null, fee, AREA[Z3]);
      expect(await split(b1.id)).toEqual([`DIRECT_1:TOP:${own25}`]);
      expect(await split((await signed(o.dealer.id, odirect.id, fee, AREA[Z3])).id)).toEqual([`DIRECT_1:${odirect.name}:${a}`, `OVERRIDE_MAIN:TOP:${d4}`].sort());
      expect(await split((await signed(o.dealer.id, ounder.id, fee, AREA[Z3])).id)).toEqual([`DIRECT_1:${ounder.name}:${a}`, `OVERRIDE_LEAD:${olead.name}:${tl}`, `OVERRIDE_MAIN:TOP:${d3}`].sort());
      expect(await split((await signed(o.dealer.id, olead.id, fee, AREA[Z3])).id)).toEqual([`DIRECT_1:${olead.name}:${a}`, `OVERRIDE_MAIN:TOP:${d4}`].sort());
      const [plan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, b1.id));
      expect(plan).toMatchObject({ model: "B", caseCode: "B1", franchiseZoneId: Z3 });
      // The owner's own shop outside his paid zone follows Model A (§7).
      expect(await split((await signed(o.dealer.id, null, fee, AREA[Z47])).id)).toEqual([`DIRECT_1:TOP:${a}`]);
    });
  }

  it("parity: one agent and one team-lead rate for both models; owner rates can never go below the free dealer's", async () => {
    await expect(saveFranchiseConfig({ ownerSelfBp: 1500 }, { reason: "lower owner (test)" }, admin)).rejects.toThrow(/cannot be lower/);
    await expect(saveFranchiseConfig({ ownerOverrideBp: 300 }, { reason: "lower owner (test)" }, admin)).rejects.toThrow(/cannot be lower/);
    await expect(saveFranchiseConfig({ ownerSecondOverrideBp: 200 }, { reason: "lower owner (test)" }, admin)).rejects.toThrow(/cannot be lower/);
    await expect(setRule("dealerTieredCommission", { ...RULES.dealerTieredCommission.defaults, enabled: true, leadOverrideBp: 600 }, admin)).rejects.toThrow(/cannot be lower/);
    await setRule("dealerTieredCommission", { ...RULES.dealerTieredCommission.defaults, enabled: true, directBp: 1800 }, admin);
    clearRuleCache();
    const o = await dealer();
    await book(o, [Z3]);
    const ag = await member(o.dealer.id, "Parity agent", "AGENT");
    expect(await split((await signed(o.dealer.id, ag.id, 100_000, AREA[Z3])).id)).toEqual([`DIRECT_1:${ag.name}:18000`, "OVERRIDE_MAIN:TOP:4000"]);
  });

  it("a refunded shop reverses every person's commission (both models)", async () => {
    const o = await dealer();
    await book(o, [Z3]);
    const ag = await member(o.dealer.id, "Refund agent", "AGENT");
    const shop = await signed(o.dealer.id, ag.id, 100_000, AREA[Z3]);
    await reverseShopCommission(shop.id, "registration fee refunded", admin);
    const rows = await db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shop.id));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((r) => r.status !== "REVERSED").reduce((sum, r) => sum + r.amountPaise, 0)).toBe(0);
    expect((await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shop.id)))[0].status).toBe("REVERSED");
  });
});

/* ================================================================ free teams in a paid zone, recurring, upgrade, tail (§4, §6, §7) */

describe("recurring commission and zone attachment", () => {
  it("a free team's shop in a paid zone: normal Model A commission, no owner override, attached to the franchise for recurring (20% of 2%)", async () => {
    const o = await dealer("Zone owner");
    const r = await book(o, [Z3]);
    const free = await dealer("Free team");
    const ag = await member(free.dealer.id, "Free agent", "AGENT");
    const shop = await signed(free.dealer.id, ag.id, 100_000, AREA[Z3]);
    expect(await split(shop.id)).toEqual([`DIRECT_1:${ag.name}:20000`, "OVERRIDE_MAIN:TOP:4000"]);
    await deliver(shop.id, 10_000_000);
    const [a] = await allocs(r.booking.id);
    const c = await calculateAllocationMonth(db, a, thisMonth());
    expect(c.newShopIds).toEqual([shop.id]);
    expect(c.result).toMatchObject({ baselinePaise: 0, commissionRateBp: 2000, recurringPaise: 40_000 }); // 20% × 2% × ₹1,00,000
  });

  it("two active franchises in the zone: a free shop's recurring is split 50/50; a zone with no franchise attaches to the next one sold", async () => {
    const free = await dealer("Free");
    const early = await signed(free.dealer.id, null, 100_000, AREA[Z7]);
    await deliver(early.id, 4_000_000); // before any franchise: nobody earns recurring
    const x = await dealer("X");
    const y = await dealer("Y");
    const rx = await book(x, [Z7]);
    const ry = await book(y, [Z7]);
    await deliver(early.id, 10_000_000);
    const [ax] = await allocs(rx.booking.id);
    const [ay] = await allocs(ry.booking.id);
    const cx = await calculateAllocationMonth(db, ax, thisMonth());
    const cy = await calculateAllocationMonth(db, ay, thisMonth());
    expect([cx.result.recurringPaise, cy.result.recurringPaise]).toEqual([20_000, 20_000]);
  });

  it("orders cancelled / refunded in the month are netted; bonus counts only shops attached at the month's start", async () => {
    const o = await dealer();
    const r = await book(o, [Z3]);
    const shop = await signed(o.dealer.id, null, 100_000, AREA[Z3]);
    const order = await deliver(shop.id, 10_000_000);
    await db.insert(financialAdjustments).values({ type: "REFUND_SHOP", party: "SHOP", status: "PENDING", shopId: shop.id, orderId: order.id, amountPaise: -4_000_000, customerRefundPaise: 4_000_000, reason: "refund (test)", idempotencyKey: `t-${order.id}` });
    const [a] = await allocs(r.booking.id);
    const c = await calculateAllocationMonth(db, a, thisMonth());
    expect(c.result).toMatchObject({ openingShops: 0, newShops: 1, recurringPaise: 24_000 }); // ₹60,000 net × 2% × 20%
  });

  it("upgrade Free → Paid: the team keeps its rates; earlier shops in the zone attach for recurring; new shops there follow Model B", async () => {
    const d = await dealer("Upgrader");
    const ag = await member(d.dealer.id, "Up agent", "AGENT");
    const before = await signed(d.dealer.id, ag.id, 100_000, AREA[Z7]);
    expect(await split(before.id)).toEqual([`DIRECT_1:${ag.name}:20000`, "OVERRIDE_MAIN:TOP:4000"]);
    await book(d, [Z7]);
    const [att] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, before.id));
    expect(att).toMatchObject({ origin: "UPGRADE", ownerDealerId: d.dealer.id, zoneId: Z7 });
    expect(await split(before.id)).toEqual([`DIRECT_1:${ag.name}:20000`, "OVERRIDE_MAIN:TOP:4000"]); // unchanged
    const after = await signed(d.dealer.id, ag.id, 100_000, AREA[Z7]);
    expect(await split(after.id)).toEqual([`DIRECT_1:${ag.name}:20000`, "OVERRIDE_MAIN:TOP:4000"]);
  });

  it("tail: after the owner stops renewing, his own team's shops keep earning for 2 years; free-team shops move to the next active owner", async () => {
    const x = await dealer("Lapsing");
    const rx = await book(x, [Z7]);
    const own = await signed(x.dealer.id, null, 100_000, AREA[Z7]);
    const free = await dealer("Free");
    const freeShop = await signed(free.dealer.id, null, 100_000, AREA[Z7]);
    const [ax] = await allocs(rx.booking.id);
    // X expired an hour ago (not renewed); Y bought the zone.
    const past = new Date(Date.now() - 3_600_000);
    await db.update(franchiseAllocations).set({ activatedAt: new Date(past.getTime() - 86_400_000), expiresAt: past, tailEndAt: new Date(past.getTime() + 2 * 365 * 86_400_000) }).where(eq(franchiseAllocations.id, ax.id));
    const { config } = await franchiseConfig();
    expect(await expireAreas(new Date(), config)).toBe(1);
    await expect(assertFranchiseCodeOpen((await db.execute(sql`select rc.code from franchise_codes fc join referral_codes rc on rc.id = fc.referral_code_id where fc.allocation_id = ${ax.id}`) as unknown as { code: string }[])[0].code)).rejects.toThrow(/closed when the franchise/);
    const y = await dealer("Next owner");
    const ry = await book(y, [Z7]);
    await deliver(own.id, 10_000_000);
    await deliver(freeShop.id, 10_000_000);
    const [ax2] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.id, ax.id));
    const [ay] = await allocs(ry.booking.id);
    const cx = await calculateAllocationMonth(db, ax2, thisMonth());
    const cy = await calculateAllocationMonth(db, ay, thisMonth());
    expect(cx.lines.map((l) => l.shopId)).toEqual([own.id]);
    expect(cx.result).toMatchObject({ bonusBp: 0, recurringPaise: 40_000 });
    expect(cy.lines.map((l) => l.shopId)).toEqual([freeShop.id]);
  });
});

/* ================================================================ month end, statement, reminders */

describe("month end, statements and reminders", () => {
  it("past month: DRAFT → lock writes the per-shop ledger lines dated in the month → never changes", async () => {
    const o = await dealer();
    const r = await book(o, [Z3]);
    const [a] = await allocs(r.booking.id);
    const prev = prevMonth(thisMonth());
    const { start } = istMonthBounds(prev);
    const twoBack = istMonthBounds(prevMonth(prev)).start;
    await db.update(franchiseAllocations).set({ activatedAt: twoBack, periodStart: twoBack }).where(eq(franchiseAllocations.id, a.id));
    const shop = await signed(o.dealer.id, null, 100_000, AREA[Z3]);
    const order = await deliver(shop.id, 10_000_000);
    const inPrev = new Date(start.getTime() + 3 * 86_400_000);
    await db.update(shops).set({ approvedAt: inPrev }).where(eq(shops.id, shop.id));
    await db.execute(sql`update franchise_shop_area_periods set valid_from = ${new Date(start.getTime() + 86_400_000).toISOString()}::timestamptz where shop_id = ${shop.id}`);
    await db.execute(sql`update order_financials set delivered_at = ${inPrev.toISOString()}::timestamptz where order_id = ${order.id}`);
    expect(await calculateFranchiseMonth(prev)).toMatchObject({ calculated: 1 });
    let [snap] = await db.select().from(franchiseMonthlySnapshots).where(eq(franchiseMonthlySnapshots.allocationId, a.id));
    expect(snap).toMatchObject({ status: "DRAFT", newShops: 1, recurringPaise: 40_000 });
    expect(await lockFranchiseMonth(prev, admin)).toMatchObject({ locked: 1 });
    [snap] = await db.select().from(franchiseMonthlySnapshots).where(eq(franchiseMonthlySnapshots.allocationId, a.id));
    expect(snap.status).toBe("LOCKED");
    const lines = (await db.select().from(dealerCommissionLedger).where(and(eq(dealerCommissionLedger.shopId, shop.id), eq(dealerCommissionLedger.entryType, "RECURRING_BASE"))));
    expect(lines.map((e) => [e.amountPaise, e.franchiseZoneId])).toEqual([[40_000, Z3]]);
    expect(await calculateFranchiseMonth(prev)).toMatchObject({ calculated: 0, locked: 1 });
    expect(statementPdf(await statementData(snap.id)).subarray(0, 5).toString()).toBe("%PDF-");
    await emailStatements(prev, ["ceo@agtci.com"]);
    const log = await db.select().from(franchiseNotificationLog).where(eq(franchiseNotificationLog.kind, `STATEMENT:${prev}`));
    expect(log.map((l) => l.recipient).sort()).toEqual([o.user.email, "ceo@agtci.com"].sort());
  });

  it("renewal reminders show the renewal fee and, when it changed, why; copied to ceo@agtci.com", async () => {
    const o = await dealer();
    const r = await book(o, [Z7]);
    const [a] = await allocs(r.booking.id);
    const at = new Date();
    at.setUTCHours(6, 0, 0, 0); // 11.30 IST, after the reminder hour
    await db.update(franchiseAllocations).set({ expiresAt: new Date(at.getTime() + 10 * 86_400_000) }).where(eq(franchiseAllocations.id, a.id));
    // A newer published fee for the zone (reset by beforeEach: non-provisional versions are removed).
    const [cur] = await db.update(franchiseZoneFeeVersions).set({ supersededAt: new Date() }).where(and(eq(franchiseZoneFeeVersions.zoneId, Z7), isNull(franchiseZoneFeeVersions.supersededAt))).returning();
    await db.insert(franchiseZoneFeeVersions).values({ zoneId: Z7, tier: "PREMIER", value: 115, average: 99.4, diffBp: 1569, feePaise: 17_000_000, reason: cur.reason, provisional: false });
    const { config } = await franchiseConfig();
    await sendReminders(at, config);
    const log = await db.select().from(franchiseNotificationLog).where(and(eq(franchiseNotificationLog.allocationId, a.id), inArray(franchiseNotificationLog.channel, ["EMAIL"])));
    expect(log.map((l) => l.recipient)).toEqual(expect.arrayContaining(["ceo@agtci.com"]));
  });
});

/* ================================================================ team rules (unchanged Model A behaviour) */

describe("team rules", () => {
  it("a team lead deactivated: his agents move under the top person; later shops pay the dealer 4%, earlier ones unchanged", async () => {
    const d = await dealer();
    const lead = await member(d.dealer.id, "LeadX", "TEAM_LEAD");
    const agent = await member(d.dealer.id, "AgentX", "AGENT", lead.id);
    const before = await signed(d.dealer.id, agent.id, 100_000, AREA[Z47]);
    await setSalespersonStatus(d.dealer.id, lead.id, "INACTIVE", admin);
    const after = await signed(d.dealer.id, agent.id, 100_000, AREA[Z47]);
    expect(await split(before.id)).toEqual(["DIRECT_1:AgentX:20000", "OVERRIDE_LEAD:LeadX:4000", "OVERRIDE_MAIN:TOP:3000"]);
    expect(await split(after.id)).toEqual(["DIRECT_1:AgentX:20000", "OVERRIDE_MAIN:TOP:4000"]);
  });

  it("a team lead adds only agents; one mobile once per team; codes GKT- / GKA-", async () => {
    const d = await dealer();
    const lead = await member(d.dealer.id, "LeadY", "TEAM_LEAD");
    await db.update(dealerSalespeople).set({ userId: (await createUser({ role: "DEALER" })).id }).where(eq(dealerSalespeople.id, lead.id));
    const [l] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, lead.id));
    const added = await leadAddsAgent({ id: l.userId!, role: "DEALER" }, { employeeId: "SUB1", name: "Sub One" });
    expect((await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, added.id)))[0]).toMatchObject({ teamRole: "AGENT", parentId: lead.id });
    await addSalesperson(d.dealer.id, { employeeId: "M1", name: "Mob One", mobile: "9876500001" }, admin);
    await expect(addSalesperson(d.dealer.id, { employeeId: "M2", name: "Mob Two", mobile: "9876500001" }, admin)).rejects.toThrow(/already in your team/);
  });

  it("moving a person to another team needs an admin and is logged", async () => {
    const a = await dealer("Dealer A");
    const b = await dealer("Dealer B");
    const v = await addSalesperson(a.dealer.id, { employeeId: "MOVE1", name: "Mover", mobile: "9876511111" }, admin);
    await expect(transferMemberToDealer(v.id, b.dealer.id, "moving teams", a.actor)).rejects.toThrow(/Only an admin/);
    const moved = await transferMemberToDealer(v.id, b.dealer.id, "asked to join Dealer B", admin);
    expect(moved.code).toMatch(/^GKA-/);
  });
});

/* ================================================================ referral moves (owner, 22-Nov-2026) */

describe("referral moves: add / move a referral code with consent letters and a second admin's approval", () => {
  const pdf = (n: string) => ({ name: `${n}.pdf`, bytes: Buffer.from(`%PDF-1.4 consent ${n}`) });
  let admin2: { id: string; role: "ADMIN" };
  beforeEach(async () => {
    const u = await createUser({ role: "ADMIN" });
    admin2 = { id: u.id, role: "ADMIN" };
  });
  const codeOf = async (memberId: string) => (await db.select().from(dealerCodes).where(eq(dealerCodes.salespersonId, memberId)))[0];

  it("adds a code to a shop that had none: the requester cannot decide, approval needs the consents, a second admin approves", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "No code shop", status: "APPROVED" });
    const b = await dealer("Receiver");
    const ag = await member(b.dealer.id, "Receiver agent", "AGENT");
    const r = await createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: b.dealer.id, toMemberId: ag.id, reason: "shop owner forgot the code at sign-up" }, admin);
    await expect(createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: b.dealer.id, reason: "a second request for it" }, admin2)).rejects.toThrow(/waiting for approval/);
    await expect(decideMoveRequest(r.id, { approve: true, note: "looks fine" }, admin)).rejects.toThrow(/different admin/);
    expect((await missingDocuments(r)).map((m) => m.kind)).toEqual(["SHOP_OWNER_CONSENT", "TO_DEALER_CONSENT"]); // no old dealer → no old consent
    await expect(decideMoveRequest(r.id, { approve: true, note: "looks fine" }, admin2)).rejects.toThrow(/missing consent letters/);
    await expect(addMoveDocument(r.id, { kind: "SHOP_OWNER_CONSENT", shopId: null, ...pdf("x") }, admin)).rejects.toThrow(/Choose which shop/);
    await expect(addMoveDocument(r.id, { kind: "TO_DEALER_CONSENT", name: "a.txt", bytes: Buffer.from("hello") }, admin)).rejects.toThrow(/PDF, JPEG/);
    await addMoveDocument(r.id, { kind: "SHOP_OWNER_CONSENT", shopId: shop.id, ...pdf("owner") }, admin);
    await addMoveDocument(r.id, { kind: "TO_DEALER_CONSENT", ...pdf("receiver") }, admin);
    const done = await decideMoveRequest(r.id, { approve: true, note: "consents checked" }, admin2);
    expect(done).toMatchObject({ status: "APPROVED", decidedBy: admin2.id });
    const [a] = await db.select().from(shopAttributions).where(eq(shopAttributions.shopId, shop.id));
    expect(a).toMatchObject({ dealerId: b.dealer.id, salespersonId: ag.id, source: "ADMIN", status: "ACTIVE" });
    expect(a.placementAt).toBeTruthy();
    const [s] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(s.referralCodeId).toBe((await codeOf(ag.id)).referralCodeId);
    await expect(decideMoveRequest(r.id, { approve: false, note: "too late" }, admin2)).rejects.toThrow(/already been decided/);
  });

  it("reject and cancel: only the requester cancels; a rejected request changes nothing", async () => {
    const a = await dealer("Keeper");
    const b = await dealer("Taker");
    const shop = await signed(a.dealer.id, null, 100_000, AREA[Z47]);
    const r1 = await createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: b.dealer.id, reason: "owner asked to change dealer" }, admin);
    await expect(cancelMoveRequest(r1.id, "not needed", admin2)).rejects.toThrow(/Only the admin who raised/);
    expect((await cancelMoveRequest(r1.id, "not needed", admin)).status).toBe("CANCELLED");
    const r2 = await createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: b.dealer.id, reason: "owner asked to change dealer" }, admin);
    expect((await missingDocuments(r2)).map((m) => m.kind)).toEqual(["SHOP_OWNER_CONSENT", "FROM_DEALER_CONSENT", "TO_DEALER_CONSENT"]);
    expect((await decideMoveRequest(r2.id, { approve: false, note: "no consent from Keeper" }, admin2)).status).toBe("REJECTED");
    expect((await db.select().from(shopAttributions).where(eq(shopAttributions.shopId, shop.id)))[0].dealerId).toBe(a.dealer.id);
  });

  it("moving a shop between two franchise teams in a zone: one-time stays with the old team, recurring splits at the move", async () => {
    const x = await dealer("Franchise X");
    const y = await dealer("Franchise Y");
    const rx = await book(x, [Z7]);
    const ry = await book(y, [Z7]);
    const ax = await member(x.dealer.id, "X agent", "AGENT");
    const ay = await member(y.dealer.id, "Y agent", "AGENT");
    const shop = await signed(x.dealer.id, ax.id, 100_000, AREA[Z7]);
    const oneTime = await split(shop.id);
    expect(oneTime).toEqual([`DIRECT_1:${ax.name}:20000`, "OVERRIDE_MAIN:TOP:4000"]);
    const before = await deliver(shop.id, 10_000_000); // ₹1,00,000 before the move
    expect(before.id).toBeTruthy();

    const r = await createMoveRequest({ kind: "SHOPS", shopIds: [shop.id], toDealerId: y.dealer.id, toMemberId: ay.id, reason: "shop owner works with Y's agent" }, admin);
    await addMoveDocument(r.id, { kind: "SHOP_OWNER_CONSENT", shopId: shop.id, ...pdf("owner") }, admin);
    await addMoveDocument(r.id, { kind: "FROM_DEALER_CONSENT", ...pdf("x") }, admin);
    await addMoveDocument(r.id, { kind: "TO_DEALER_CONSENT", ...pdf("y") }, admin);
    await new Promise((r) => setTimeout(r, 20));
    const at = new Date(); // after the first delivery, before the second
    await decideMoveRequest(r.id, { approve: true, note: "all three consents signed", at }, admin2);
    await deliver(shop.id, 5_000_000); // ₹50,000 after the move

    expect(await split(shop.id)).toEqual(oneTime); // earned one-time stays where it was earned
    const [plan] = await db.select().from(dealerTierShopPlans).where(eq(dealerTierShopPlans.shopId, shop.id));
    expect(plan).toMatchObject({ dealerId: y.dealer.id, directMemberId: ay.id }); // renewals and unearned parts: new team
    const [att] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shop.id));
    expect(att).toMatchObject({ ownerDealerId: y.dealer.id, status: "ACTIVE" });
    expect(att.attachedFrom?.getTime()).toBe(at.getTime());
    const [period] = await db.select().from(franchiseShopTeamPeriods).where(eq(franchiseShopTeamPeriods.shopId, shop.id));
    expect(period).toMatchObject({ ownerDealerId: x.dealer.id, zoneId: Z7 });

    const [aX] = await allocs(rx.booking.id);
    const [aY] = await allocs(ry.booking.id);
    const cX = await calculateAllocationMonth(db, aX, thisMonth());
    const cY = await calculateAllocationMonth(db, aY, thisMonth());
    expect([cX.result.recurringPaise, cY.result.recurringPaise]).toEqual([40_000, 20_000]); // 20% × 2% × ₹1,00,000 / ₹50,000
  });

  it("moving a team member: he keeps his own code, his shops come along, his earned commission stays", async () => {
    const a = await dealer("Old team");
    const y = await dealer("New franchise");
    await book(y, [Z7]);
    const lead = await member(y.dealer.id, "Y lead", "TEAM_LEAD");
    const v = await member(a.dealer.id, "Mover agent", "AGENT");
    const shop = await signed(a.dealer.id, v.id, 100_000, AREA[Z7]);
    const earned = await split(shop.id);
    const oldCode = await codeOf(v.id);
    const [{ code }] = await db.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.id, oldCode.referralCodeId));

    const r = await createMoveRequest({ kind: "MEMBER", memberId: v.id, toDealerId: y.dealer.id, toMemberId: lead.id, reason: "agent joins Y's franchise team" }, admin);
    expect((await missingDocuments(r)).map((m) => m.kind)).toEqual(["MEMBER_CONSENT", "FROM_DEALER_CONSENT", "TO_DEALER_CONSENT"]);
    for (const kind of ["MEMBER_CONSENT", "FROM_DEALER_CONSENT", "TO_DEALER_CONSENT"] as const) await addMoveDocument(r.id, { kind, ...pdf(kind) }, admin);
    const done = await decideMoveRequest(r.id, { approve: true, note: "consents signed by all three" }, admin2);
    const res = done.result as { newMemberId: string; keptCode: string };
    expect(res.keptCode).toBe(code);

    const [moved] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, res.newMemberId));
    expect(moved).toMatchObject({ dealerId: y.dealer.id, parentId: lead.id, status: "ACTIVE" });
    const [kept] = await db.select().from(dealerCodes).where(eq(dealerCodes.referralCodeId, oldCode.referralCodeId));
    expect(kept).toMatchObject({ dealerId: y.dealer.id, salespersonId: res.newMemberId, status: "ACTIVE" });
    const others = await db.select().from(dealerCodes).where(and(eq(dealerCodes.salespersonId, res.newMemberId), eq(dealerCodes.status, "ACTIVE")));
    expect(others).toHaveLength(1); // the code made for the new place is retired
    const [att] = await db.select().from(shopAttributions).where(eq(shopAttributions.shopId, shop.id));
    expect(att).toMatchObject({ dealerId: y.dealer.id, salespersonId: res.newMemberId, source: "ADMIN" });
    expect(await split(shop.id)).toEqual(earned);
    const [fsa] = await db.select().from(franchiseShopAttributions).where(eq(franchiseShopAttributions.shopId, shop.id));
    expect(fsa).toMatchObject({ ownerDealerId: y.dealer.id, status: "ACTIVE" });
  });
});
