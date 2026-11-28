/**
 * Onboarding v2 — Flow 3, franchise (docs/onboarding-v2-2026-11), against real PostgreSQL.
 *   live shop required (else shop registration with return=/franchise/start) · free dealer live at once with a GKD
 *   code · paid franchise: zones + plan + coupon + payment → live with a GKF code, no kyc_due_at · max 2 per zone ·
 *   plan pricing (fixed vs zone tier fee, term) · admin plans (audited) · flag off = the 30-day KYC rule as before.
 */
import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { FRANCHISE_AGREEMENT_V2_VERSION, FRANCHISE_AGREEMENT_VERSION } from "@/lib/franchise";
import { encryptSecret, panBlindIndex } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  notifications,
  auditLogs,
  dealers,
  franchiseAllocations,
  franchiseBookings,
  franchiseCampaigns,
  franchiseCodes,
  franchiseConfigVersions,
  franchiseCouponAssignments,
  franchiseCouponRedemptions,
  franchiseCoupons,
  franchisePlans,
  franchiseZones,
  onboardingRoleHistory,
  paymentIntents,
  paymentSandboxOrders,
  shops,
  userRoleGrants,
} from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import {
  acceptFranchiseAgreement,
  cancelReservation,
  onFranchiseFeeCaptured,
  pendingPlanBookings,
  previewCart,
  releaseLapsedPlanPayments,
  reserveZones,
  startBookingPayment,
  sweepFranchiseKyc,
} from "@/server/franchise/booking";
import { getGatewayByName } from "@/server/payments/gateway/registry";
import type { SandboxGateway } from "@/server/payments/gateway/sandbox";
import { saveFranchiseConfig } from "@/server/franchise/config";
import { createCoupon } from "@/server/franchise/coupons";
import { zoneView } from "@/server/franchise/zones";
import { SHOP_REGISTER_FOR_FRANCHISE, becomeFreeDealer, createPlan, franchiseStartState, retryV2GoLive, setPlanActive, startPaidFranchise, updatePlan } from "@/server/onboarding-v2/franchise";
import { listMarketplaceRoles } from "@/server/onboarding-v2/roles";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

type PaymentIntentRefT = PaymentIntentRef;

/** 03 Shivajinagar–Deccan: Premier ₹2,26,000 (seed); 07 Karve Nagar–Erandwane: Standard ₹1,50,000. */
const Z3 = "GKZ-PUN-03";
const Z7 = "GKZ-PUN-07";

let admin: { id: string; role: "ADMIN" };

async function flag(on: boolean) {
  await setFeatureFlag("onboarding_v2", { enabled: on, districtCodes: null }, on ? "on (test)" : "off (test)", admin);
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(franchiseCouponRedemptions);
  await db.delete(franchiseCouponAssignments);
  await db.delete(franchiseCoupons);
  await db.delete(franchisePlans).where(like(franchisePlans.code, "T_%"));
  await db.update(franchisePlans).set({ active: true }).where(eq(franchisePlans.code, "LAUNCH_1Y"));
  await db.update(franchiseZones).set({ status: "AVAILABLE", statusReason: null, reservedForDealerId: null, reservedUntil: null, maxOwners: 2 });
  await db.delete(franchiseConfigVersions);
  await db.update(franchiseCampaigns).set({ closedAt: null, closedReason: null, ownersAtClose: null, areasAtClose: null });
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  await saveFranchiseConfig({ bookingOpen: true, allowProvisionalSale: true, promoFeePaise: null }, { reason: "open for the tests" }, admin);
  await flag(true);
});

/* ================================================================ helpers */

/**
 * Owner, 28-Nov-2026: a free franchisee request is approved by an admin and confirmed by a different admin or operator
 * (src/server/dealers/promotion.ts) — only then the GKD code is issued.
 */
async function approveFreeRequest(dealerId: string): Promise<{ code: string | null }> {
  const { proposeDealerPromotion } = await import("@/server/dealers/promotion");
  const { decideApproval } = await import("@/server/approvals");
  const proposed = await proposeDealerPromotion(dealerId, { action: "APPROVE", agreementStart: "2026-11-27", agreementEnd: "2027-11-26" }, admin);
  const second = await createUser({ role: "ADMIN" });
  const decided = await decideApproval({ requestId: proposed.approvalId, actor: { id: second.id, role: "ADMIN" }, decision: "APPROVE" });
  if (!decided.applied) throw new Error(decided.applyError ?? "not applied");
  const { listDealerCodes } = await import("@/server/dealers/codes");
  return { code: (await listDealerCodes(dealerId)).find((c) => c.kind === "DEALER" && c.status === "ACTIVE")?.code ?? null };
}

const pan = () => `ABCDE${String(Math.floor(1000 + Math.random() * 8999))}F`;

/** A signed-in customer with a live (approved) shop; GSTIN and PAN on the shop when asked. */
async function shopOwner(opts: { withPan?: boolean; shopStatus?: "APPROVED" | "PENDING_APPROVAL" } = {}) {
  const user = await createUser({ role: "SHOP_OWNER", name: "Asha Kulkarni" });
  const shop = await createShop(user.id, { name: `Asha Stores ${Math.random().toString(36).slice(2, 6)}`, status: opts.shopStatus ?? "APPROVED", shopType: "GENERAL_TRADING" as never });
  if (opts.withPan) {
    const p = pan();
    await db.update(shops).set({ gstin: "27ABCDE1234F1Z5", panNumberEncrypted: encryptSecret(p), panHash: panBlindIndex(p), panLast4: p.slice(-4) }).where(eq(shops.id, shop.id));
  }
  return { user, shop, actor: { id: user.id, role: "SHOP_OWNER" as const } };
}

async function capture(bookingId: string) {
  const [b] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, bookingId));
  const intent = { id: b.paymentIntentId ?? randomUUID(), purpose: "FRANCHISE_FEE", referenceId: b.id, userId: null, amountPaise: Number(b.totalPaise), refundedPaise: 0, status: "CAPTURED", gateway: "SANDBOX", gatewayOrderId: null, gatewayPaymentId: null } as unknown as PaymentIntentRefT;
  const after: (() => Promise<void>)[] = [];
  await db.transaction((tx) => onFranchiseFeeCaptured(intent, tx, (task) => after.push(task)));
  for (const task of after) await task();
}

const launchPlan = async () => (await db.select().from(franchisePlans).where(eq(franchisePlans.code, "LAUNCH_1Y")))[0];

async function plan(over: Partial<Parameters<typeof createPlan>[0]> = {}) {
  return createPlan({ code: `T_${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name: "Test plan", durationMonths: 12, pricePerZonePaise: 10_000_000, gstExtra: true, isLaunchOffer: false, active: true, sortOrder: 5, ...over }, admin);
}

/** v2 paid buyer ready to reserve: dealer row from the shop, v2 rules accepted. */
async function paidBuyer(opts: { withPan?: boolean } = {}) {
  const o = await shopOwner(opts);
  await startPaidFranchise(o.actor);
  await acceptFranchiseAgreement(o.actor, FRANCHISE_AGREEMENT_V2_VERSION, { ipAddress: "127.0.0.1", userAgent: "vitest" });
  return o;
}

/* ================================================================ live shop */

describe("a live registered shop is mandatory", () => {
  it("no shop: both models refused with the shop registration link (return=/franchise/start)", async () => {
    const user = await createUser({ role: "CUSTOMER" });
    const actor = { id: user.id, role: "CUSTOMER" as const };
    expect(SHOP_REGISTER_FOR_FRANCHISE).toBe("/shop/register?return=%2Ffranchise%2Fstart");
    for (const run of [() => becomeFreeDealer(actor), () => startPaidFranchise(actor)]) {
      const err = await run().then(() => null, (e: unknown) => e as { code: string; details?: { reason?: string; redirect?: string } });
      expect(err?.code).toBe("CONFLICT");
      expect(err?.details).toMatchObject({ reason: "SHOP_REQUIRED", redirect: SHOP_REGISTER_FOR_FRANCHISE });
    }
    expect(await db.select().from(dealers).where(eq(dealers.userId, user.id))).toHaveLength(0);
    expect((await franchiseStartState(user.id)).shop).toBeNull();
  });

  it("a shop still waiting for approval is not live", async () => {
    const o = await shopOwner({ shopStatus: "PENDING_APPROVAL" });
    await expect(becomeFreeDealer(o.actor)).rejects.toThrow(/Register your shop first/);
  });

  it("flag off: Become a franchisee is closed", async () => {
    await flag(false);
    const o = await shopOwner();
    await expect(becomeFreeDealer(o.actor)).rejects.toThrow(/not open yet/);
    await expect(startPaidFranchise(o.actor)).rejects.toThrow(/not open yet/);
  });
});

/* ================================================================ free dealer */

describe("free franchisee: a request an admin approves, then a GKD code (owner, 27-Nov-2026)", () => {
  const approve = (dealerId: string) => approveFreeRequest(dealerId);

  it("the request waits (PENDING, no code, no DEALER role); an admin approves it on the shop's details: code, role, history, notice", async () => {
    const o = await shopOwner({ withPan: true });
    const r = await becomeFreeDealer(o.actor);
    expect(r).toMatchObject({ approvedNow: false, code: null, status: "PENDING" });
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    expect(d).toMatchObject({ status: "PENDING", source: "SHOP_REQUEST", gstin: "27ABCDE1234F1Z5", dealerType: "PROPRIETORSHIP", city: "Pune", pincode: "411001" });
    expect(d.panHash).not.toBeNull(); // the shop's PAN, not asked again
    expect(await db.select().from(userRoleGrants).where(and(eq(userRoleGrants.userId, o.user.id), eq(userRoleGrants.role, "DEALER")))).toHaveLength(0);
    expect((await franchiseStartState(o.user.id)).dealer?.status).toBe("PENDING");
    // A second tap returns the same request.
    expect(await becomeFreeDealer(o.actor)).toEqual({ dealerId: d.id, code: null, approvedNow: false, status: "PENDING" });
    expect(await db.select().from(dealers).where(eq(dealers.userId, o.user.id))).toHaveLength(1);

    // The admin approves: no documents, mobile call or bank check for a shop request.
    const decided = await approve(d.id);
    expect(decided.code).toMatch(/^GKD-[23456789A-Z]{6}$/);
    const [after] = await db.select().from(dealers).where(eq(dealers.id, d.id));
    expect(after.status).toBe("APPROVED");
    const [grant] = await db.select().from(userRoleGrants).where(and(eq(userRoleGrants.userId, o.user.id), eq(userRoleGrants.role, "DEALER")));
    expect(grant.status).toBe("ACTIVE");
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, o.user.id));
    expect(history.map((h) => `${h.role}:${h.action}`)).toEqual(["dealer_free:GRANTED"]);
    expect((await listMarketplaceRoles(o.user.id)).roles).toEqual(expect.arrayContaining(["customer", "dealer_free"]));
    const notes = await db.select().from(notifications).where(and(eq(notifications.userId, o.user.id), eq(notifications.type, "dealer.status_changed"), eq(notifications.channel, "IN_APP")));
    expect(notes.some((n) => n.body.includes(decided.code!))).toBe(true);
    expect(await becomeFreeDealer(o.actor)).toEqual({ dealerId: d.id, code: decided.code, approvedNow: false, status: "APPROVED" });
  });

  it("without a PAN on the shop he is still approved; PAN + bank are asked before the first payout only", async () => {
    const o = await shopOwner();
    const r = await becomeFreeDealer(o.actor);
    await approve(r.dealerId);
    const s = await franchiseStartState(o.user.id);
    expect(s.isFreeDealer).toBe(true);
    expect(s.payoutMissing).toEqual(["PAN", "payout bank account"]);
  });

  it("a request whose shop is no longer live cannot be approved", async () => {
    const o = await shopOwner();
    const r = await becomeFreeDealer(o.actor);
    await db.update(shops).set({ status: "SUSPENDED" }).where(eq(shops.ownerId, o.user.id));
    await expect(approve(r.dealerId)).rejects.toThrow(/no longer live/);
  });

  it("the full dealer application also needs a live shop (rule dealerApplication)", async () => {
    await setRule("dealerApplication", { requireLiveShop: true }, admin);
    const u = await createUser({ role: "CUSTOMER" });
    await db.insert(dealers).values({ userId: u.id, legalName: "No Shop", contactName: "No Shop", dealerType: "INDIVIDUAL", status: "DRAFT" });
    const { submitApplication } = await import("@/server/dealers/service");
    await expect(submitApplication({ id: u.id, role: "CUSTOMER" } as never, "x", { smsAvailable: false })).rejects.toThrow(/Register your shop first/);
  });
});

/* ================================================================ paid franchise */

describe("paid franchise: zones + plan + coupon + payment → live at payment", () => {
  it("launch plan ₹1,50,000 per zone + coupon; live at payment, GKF code, no kyc_due_at, plan stored", async () => {
    const o = await paidBuyer();
    const p = await launchPlan();
    const c = await createCoupon({ code: `V2${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: "Ten off", discountType: "PERCENT", percentBp: 1000, scope: { all: true }, appliesOn: "BOTH", visibility: "PUBLIC", startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 86_400_000) }, admin);

    const priced = await previewCart(o.actor, { zoneIds: [Z3], couponCode: c.code, planId: p.id });
    expect(priced.lines[0].listPaise).toBe(15_000_000); // fixed plan price, not the Premier tier fee
    expect(priced.discountPaise).toBe(1_500_000);
    expect(priced.plan?.code).toBe("LAUNCH_1Y");

    const r = await reserveZones(o.actor, { zoneIds: [Z3], couponCode: c.code, planId: p.id });
    expect(r.booking.planId).toBe(p.id);
    expect(r.booking.launchOffer).toBe(true);
    expect(Number(r.booking.basePaise)).toBe(13_500_000);
    expect(Number(r.booking.totalPaise)).toBe(13_500_000 + Math.round(13_500_000 * 0.18));
    await capture(r.booking.id);

    const [a] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, r.booking.id));
    expect(a.status).toBe("ACTIVE");
    expect(a.kycDueAt).toBeNull();
    const codes = await db.select().from(franchiseCodes).where(eq(franchiseCodes.allocationId, a.id));
    expect(codes).toHaveLength(1);
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    expect(d.status).toBe("APPROVED");
    expect(d.panHash).toBeNull(); // paid and live without a PAN
    const roles = await listMarketplaceRoles(o.user.id);
    expect(roles.roles).toContain("franchisee_paid");
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, o.user.id));
    expect(history.map((h) => `${h.role}:${h.action}`)).toEqual(["franchisee_paid:GRANTED"]);
    // 12 months from today (IST), ending 23:59:59 IST the day before.
    const months = (a.expiresAt!.getTime() - a.activatedAt!.getTime()) / (30.44 * 86_400_000);
    expect(Math.round(months)).toBe(12);
    // The KYC sweep has nothing to do for it.
    expect((await sweepFranchiseKyc()).waiting.filter((w) => w.bookingId === r.booking.id)).toEqual([]);
  });

  it("a free dealer upgrading keeps his GKD code and gets the GKF code at payment", async () => {
    const o = await shopOwner();
    const free = await becomeFreeDealer(o.actor);
    free.code = (await approveFreeRequest(free.dealerId)).code;
    await startPaidFranchise(o.actor);
    await acceptFranchiseAgreement(o.actor, FRANCHISE_AGREEMENT_V2_VERSION, { ipAddress: null, userAgent: null });
    const r = await reserveZones(o.actor, { zoneIds: [Z7], planId: (await launchPlan()).id });
    await capture(r.booking.id);
    expect((await franchiseStartState(o.user.id)).dealer?.code).toBe(free.code);
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, o.user.id));
    expect(history.map((h) => h.role).sort()).toEqual(["dealer_free", "franchisee_paid"]);
    expect((await listMarketplaceRoles(o.user.id)).roles).toContain("franchisee_paid");
  });

  it("the v2 rules must be accepted (the old text does not count) and a plan is mandatory to skip KYC", async () => {
    const o = await shopOwner();
    await startPaidFranchise(o.actor);
    await acceptFranchiseAgreement(o.actor, FRANCHISE_AGREEMENT_VERSION, { ipAddress: null, userAgent: null });
    await expect(reserveZones(o.actor, { zoneIds: [Z7], planId: (await launchPlan()).id })).rejects.toThrow(/Accept the franchise responsibilities/);
    // Without a plan the old path still wants the PAN.
    await expect(reserveZones(o.actor, { zoneIds: [Z7] })).rejects.toThrow(/PAN/);
  });

  it("at most 2 franchises a zone: the third buyer is refused", async () => {
    const p = await launchPlan();
    for (let i = 0; i < 2; i++) {
      const o = await paidBuyer();
      await capture((await reserveZones(o.actor, { zoneIds: [Z7], planId: p.id })).booking.id);
    }
    expect((await zoneView(Z7)).slotsFree).toBe(0);
    const third = await paidBuyer();
    await expect(reserveZones(third.actor, { zoneIds: [Z7], planId: p.id })).rejects.toThrow(/sold out/);
  });

  it("an inactive or unknown plan is refused; flag off refuses any plan", async () => {
    const o = await paidBuyer();
    const t = await plan();
    await setPlanActive(t.id, false, admin);
    await expect(reserveZones(o.actor, { zoneIds: [Z7], planId: t.id })).rejects.toThrow(/subscription plans on offer/);
    await expect(reserveZones(o.actor, { zoneIds: [Z7], planId: randomUUID() })).rejects.toThrow(/subscription plans on offer/);
    await flag(false);
    await expect(reserveZones(o.actor, { zoneIds: [Z7], planId: (await launchPlan()).id })).rejects.toThrow(/not open yet/);
  });
});

/* ================================================================ plan pricing */

describe("plan pricing and term", () => {
  it("fixed price for every zone vs the zone's own tier fee (null price); GST on top", async () => {
    const o = await paidBuyer();
    const fixed = await plan({ pricePerZonePaise: 9_900_000 });
    const tier = await plan({ pricePerZonePaise: null });
    const z3 = await zoneView(Z3);
    const z7 = await zoneView(Z7);
    const a = await previewCart(o.actor, { zoneIds: [Z3, Z7], planId: fixed.id });
    expect(a.lines.map((l) => l.listPaise)).toEqual([9_900_000, 9_900_000]);
    const b = await previewCart(o.actor, { zoneIds: [Z3, Z7], planId: tier.id });
    expect(b.lines.map((l) => l.listPaise)).toEqual([z3.regularFeePaise, z7.regularFeePaise]);
    expect(b.lines[0].listPaise).not.toBe(b.lines[1].listPaise); // Premier vs Standard
    expect(b.gstPaise).toBe(Math.round(b.basePaise * 0.18));
  });

  it("a 24-month plan outside the launch offer: term from the plan, not counted as a launch place", async () => {
    const o = await paidBuyer();
    const long = await plan({ durationMonths: 24, pricePerZonePaise: 20_000_000 });
    const r = await reserveZones(o.actor, { zoneIds: [Z3], planId: long.id });
    expect(r.booking.launchOffer).toBe(false);
    await capture(r.booking.id);
    const [a] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, r.booking.id));
    expect(Math.round((a.expiresAt!.getTime() - a.activatedAt!.getTime()) / (30.44 * 86_400_000))).toBe(24);
    expect(a.launchOffer).toBe(false);
    expect(a.kycDueAt).toBeNull();
  });
});

/* ================================================================ admin plans */

describe("admin: subscription plans", () => {
  it("add, edit, deactivate — admin only, audited", async () => {
    const t = await plan({ name: "Two-year plan", durationMonths: 24 });
    const edited = await updatePlan(t.id, { code: t.code, name: "Two-year plan (edited)", description: "Longer term", durationMonths: 24, pricePerZonePaise: null, gstExtra: true, isLaunchOffer: false, active: true, sortOrder: 2 }, admin);
    expect(edited).toMatchObject({ name: "Two-year plan (edited)", pricePerZonePaise: null, updatedBy: admin.id });
    const off = await setPlanActive(t.id, false, admin);
    expect(off.active).toBe(false);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "franchise_plan"), eq(auditLogs.entityId, t.id)));
    expect(audit).toHaveLength(3);
    const someone = await createUser({ role: "OPERATOR" });
    await expect(setPlanActive(t.id, true, { id: someone.id, role: "OPERATOR" })).rejects.toThrow(/Only an admin/);
    await expect(plan({ code: t.code })).rejects.toThrow(/already exists/);
    await expect(plan({ durationMonths: 0 })).rejects.toThrow(/check the plan/);
  });
});

/* ================================================================ flag off */

describe("flag off: exactly today's paid flow (30-day KYC rule)", () => {
  it("a paid booking without a plan still waits for KYC: kyc_due_at = payment + 30 days, no code", async () => {
    await flag(false);
    const user = await createUser({ role: "CUSTOMER" });
    const actor = { id: user.id, role: "CUSTOMER" as const };
    const p = pan();
    await db.insert(dealers).values({ userId: user.id, legalName: "Old Flow", contactName: "Old Flow", dealerType: "INDIVIDUAL", status: "DRAFT", panEnc: encryptSecret(p), panHash: panBlindIndex(p), panLast4: p.slice(-4) });
    await acceptFranchiseAgreement(actor, FRANCHISE_AGREEMENT_VERSION, { ipAddress: null, userAgent: null });
    const r = await reserveZones(actor, { zoneIds: [Z7] });
    expect(r.booking.planId).toBeNull();
    const before = Date.now();
    await capture(r.booking.id);
    const [a] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, r.booking.id));
    expect(a.kycDueAt).not.toBeNull();
    expect(Math.round((a.kycDueAt!.getTime() - before) / 86_400_000)).toBe(30);
    expect(await db.select().from(franchiseCodes).where(eq(franchiseCodes.allocationId, a.id))).toHaveLength(0);
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, user.id));
    expect(d.status).toBe("DRAFT");
    expect(await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, user.id))).toHaveLength(0);
    expect((await sweepFranchiseKyc()).waiting.map((w) => w.bookingId)).toContain(r.booking.id);
  });
});

/* ================================================================ review fixes */

describe("review fixes: shop gate on the booking API, go-live after the capture, plan snapshot", () => {
  it("a DRAFT dealer without a live shop cannot book on a plan (no GKD by the back door)", async () => {
    const user = await createUser({ role: "CUSTOMER" });
    const actor = { id: user.id, role: "CUSTOMER" as const };
    await db.insert(dealers).values({ userId: user.id, legalName: "No Shop", contactName: "No Shop", dealerType: "INDIVIDUAL", status: "DRAFT" });
    await acceptFranchiseAgreement(actor, FRANCHISE_AGREEMENT_V2_VERSION, { ipAddress: null, userAgent: null });
    await expect(reserveZones(actor, { zoneIds: [Z7], planId: (await launchPlan()).id })).rejects.toMatchObject({ details: { reason: "SHOP_REQUIRED" } });
    expect(await db.select().from(franchiseBookings)).toHaveLength(0);
  });

  it("paying a plan booking re-checks the live shop", async () => {
    const o = await paidBuyer();
    const r = await reserveZones(o.actor, { zoneIds: [Z7], planId: (await launchPlan()).id });
    await db.update(shops).set({ status: "SUSPENDED" }).where(eq(shops.id, o.shop.id));
    await expect(startBookingPayment(r.booking.id, o.actor)).rejects.toThrow(/Register your shop first/);
  });

  it("the plan is snapshotted at reserve: an admin edit before payment does not change the term", async () => {
    const o = await paidBuyer();
    const t = await plan({ durationMonths: 24, pricePerZonePaise: 12_000_000 });
    const r = await reserveZones(o.actor, { zoneIds: [Z7], planId: t.id });
    expect(r.booking).toMatchObject({ planCode: t.code, planDurationMonths: 24, planPricePerZonePaise: 12_000_000 });
    await updatePlan(t.id, { code: t.code, name: t.name, durationMonths: 6, pricePerZonePaise: 1_000_000, gstExtra: true, isLaunchOffer: false, active: true, sortOrder: 0 }, admin);
    await capture(r.booking.id);
    const [a] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, r.booking.id));
    expect(Math.round((a.expiresAt!.getTime() - a.activatedAt!.getTime()) / (30.44 * 86_400_000))).toBe(24);
    expect(Number(a.feePaise)).toBe(12_000_000);
  });

  it("a go-live failure never undoes the capture; the franchise job finishes it", async () => {
    const o = await paidBuyer();
    const r = await reserveZones(o.actor, { zoneIds: [Z7], planId: (await launchPlan()).id });
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    // No account on the dealer row: code issue fails inside the go-live.
    await db.update(dealers).set({ userId: null }).where(eq(dealers.id, d.id));
    await capture(r.booking.id);
    const [b] = await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, r.booking.id));
    expect(b.status).toBe("PAID");
    const [a] = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, r.booking.id));
    expect(a.status).toBe("ACTIVE");
    expect(a.kycDueAt).toBeNull();
    expect(await db.select().from(franchiseCodes).where(eq(franchiseCodes.allocationId, a.id))).toHaveLength(0);
    const problems = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "franchise_booking"), eq(auditLogs.entityId, r.booking.id)));
    expect(problems.some((p) => (p.newValue as { problem?: string } | null)?.problem === "v2_go_live_failed")).toBe(true);

    await db.update(dealers).set({ userId: o.user.id }).where(eq(dealers.id, d.id));
    expect(await retryV2GoLive()).toEqual({ retried: 1, failed: 0 });
    expect(await db.select().from(franchiseCodes).where(eq(franchiseCodes.allocationId, a.id))).toHaveLength(1);
    expect((await db.select().from(dealers).where(eq(dealers.id, d.id)))[0].status).toBe("APPROVED");
    expect((await listMarketplaceRoles(o.user.id)).roles).toContain("franchisee_paid");
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, o.user.id));
    expect(history.map((h) => `${h.role}:${h.action}`)).toEqual(["franchisee_paid:GRANTED"]);
    expect(await retryV2GoLive()).toEqual({ retried: 0, failed: 0 });
  });
});

/* ================================================================ QA D-169 */

describe("QA D-169: an abandoned paid-franchise checkout (plan booking)", () => {
  async function openCheckout(withCoupon = false) {
    const o = await paidBuyer();
    const p = await launchPlan();
    const c = withCoupon
      ? await createCoupon({ code: `D9${Math.random().toString(36).slice(2, 6).toUpperCase()}`, name: "Ten off", discountType: "PERCENT", percentBp: 1000, scope: { all: true }, appliesOn: "BOTH", visibility: "PUBLIC", startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 86_400_000) }, admin)
      : null;
    const r = await reserveZones(o.actor, { zoneIds: [Z7], planId: p.id, couponCode: c?.code ?? null });
    const started = await startBookingPayment(r.booking.id, o.actor);
    return { o, p, booking: r.booking, intentId: started.intent.id };
  }

  const bookingRow = async (id: string) => (await db.select().from(franchiseBookings).where(eq(franchiseBookings.id, id)))[0];
  const intentRow = async (id: string) => (await db.select().from(paymentIntents).where(eq(paymentIntents.id, id)))[0];

  it("held until covers the open checkout; Continue payment reuses it; it is listed on /franchise/start", async () => {
    const { o, booking, intentId } = await openCheckout();
    const b = await bookingRow(booking.id);
    const intent = await intentRow(intentId);
    expect(b.status).toBe("PAYMENT_PENDING");
    expect(b.holdExpiresAt.getTime()).toBeGreaterThanOrEqual(intent.expiresAt!.getTime() - 1_000);

    const again = await startBookingPayment(booking.id, o.actor);
    expect(again.intent.id).toBe(intentId);

    const pending = await pendingPlanBookings(o.user.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: booking.id, status: "PAYMENT_PENDING", zones: [Z7] });
    expect(pending[0].heldUntilIst).toMatch(/IST|\d/);
  });

  it("Cancel releases the zone and the coupon hold, ends the attempt and stops the gateway order", async () => {
    const { o, booking, intentId } = await openCheckout(true);
    await cancelReservation(booking.id, o.actor);
    expect((await bookingRow(booking.id)).status).toBe("CANCELLED");
    const allocs = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, booking.id));
    expect(allocs.map((a) => a.status)).toEqual(["CANCELLED"]);
    const [redemption] = await db.select().from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.bookingId, booking.id));
    expect(redemption.status).toBe("RELEASED");
    const intent = await intentRow(intentId);
    expect(intent.status).toBe("FAILED");
    const [order] = await db.select().from(paymentSandboxOrders).where(eq(paymentSandboxOrders.gatewayOrderId, intent.gatewayOrderId!));
    expect(order.status).toBe("EXPIRED");
    expect(await pendingPlanBookings(o.user.id)).toEqual([]);
    // The same zone can be reserved again at once.
    const again = await reserveZones(o.actor, { zoneIds: [Z7], planId: (await launchPlan()).id });
    expect(again.booking.status).toBe("RESERVED");
  });

  it("Cancel after the payment went through keeps the booking (the gateway is asked first)", async () => {
    const { o, booking, intentId } = await openCheckout();
    const sandbox = getGatewayByName("SANDBOX") as SandboxGateway;
    await sandbox.simulate((await intentRow(intentId)).gatewayOrderId!, "SUCCESS");
    await expect(cancelReservation(booking.id, o.actor)).rejects.toThrow(/already paid/);
    expect((await bookingRow(booking.id)).status).toBe("PAID");
  });

  it("the expiry job releases the zone at held until; Continue then asks to reserve again", async () => {
    const { o, booking, intentId } = await openCheckout(true);
    // Not yet: still within the hold, nothing happens.
    expect(await releaseLapsedPlanPayments(new Date())).toBe(0);
    expect((await bookingRow(booking.id)).status).toBe("PAYMENT_PENDING");

    // Held until (and the gateway order's own time) has passed; the gateway still reports it open.
    const past = new Date(Date.now() - 60_000);
    await db.update(franchiseBookings).set({ holdExpiresAt: past }).where(eq(franchiseBookings.id, booking.id));
    await db.update(paymentIntents).set({ expiresAt: past }).where(eq(paymentIntents.id, intentId));
    expect(await releaseLapsedPlanPayments(new Date())).toBe(1);

    const b = await bookingRow(booking.id);
    expect(b.status).toBe("EXPIRED");
    const allocs = await db.select().from(franchiseAllocations).where(eq(franchiseAllocations.bookingId, booking.id));
    expect(allocs.map((a) => a.status)).toEqual(["RESERVATION_EXPIRED"]);
    expect((await intentRow(intentId)).status).toBe("EXPIRED");
    const [redemption] = await db.select().from(franchiseCouponRedemptions).where(eq(franchiseCouponRedemptions.bookingId, booking.id));
    expect(redemption.status).toBe("RELEASED");
    await expect(startBookingPayment(booking.id, o.actor)).rejects.toThrow(/reserve again/i);
    const again = await reserveZones(o.actor, { zoneIds: [Z7], planId: (await launchPlan()).id });
    expect(again.booking.status).toBe("RESERVED");
  });

  it("Continue payment on a checkout past its time ends it and asks to reserve again (no wait for the job)", async () => {
    const { o, booking, intentId } = await openCheckout();
    const past = new Date(Date.now() - 60_000);
    await db.update(franchiseBookings).set({ holdExpiresAt: past }).where(eq(franchiseBookings.id, booking.id));
    await db.update(paymentIntents).set({ expiresAt: past }).where(eq(paymentIntents.id, intentId));
    await expect(startBookingPayment(booking.id, o.actor)).rejects.toThrow(/reserve it again/);
    expect((await bookingRow(booking.id)).status).toBe("EXPIRED");
    expect(await pendingPlanBookings(o.user.id)).toEqual([]);
  });

  it("bookings without a plan (flag off) are untouched by the new release: they wait for the gateway as before", async () => {
    const { booking, intentId } = await openCheckout();
    const past = new Date(Date.now() - 60_000);
    // As a pre-v2 booking: no plan, hold and gateway time passed, the gateway still reports it open.
    await db.update(franchiseBookings).set({ planId: null, planCode: null, holdExpiresAt: past }).where(eq(franchiseBookings.id, booking.id));
    await db.update(paymentIntents).set({ expiresAt: past }).where(eq(paymentIntents.id, intentId));
    await flag(false);
    expect(await releaseLapsedPlanPayments(new Date())).toBe(0);
    expect((await bookingRow(booking.id)).status).toBe("PAYMENT_PENDING");
    expect((await intentRow(intentId)).status).toBe("PENDING");
  });
});
