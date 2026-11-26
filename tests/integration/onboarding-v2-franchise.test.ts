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
  shops,
  userRoleGrants,
} from "@/server/db/schema";
import type { PaymentIntentRef } from "@/server/payments/intents";
import { acceptFranchiseAgreement, onFranchiseFeeCaptured, previewCart, reserveZones, startBookingPayment, sweepFranchiseKyc } from "@/server/franchise/booking";
import { saveFranchiseConfig } from "@/server/franchise/config";
import { createCoupon } from "@/server/franchise/coupons";
import { zoneView } from "@/server/franchise/zones";
import { SHOP_REGISTER_FOR_FRANCHISE, becomeFreeDealer, createPlan, franchiseStartState, retryV2GoLive, setPlanActive, startPaidFranchise, updatePlan } from "@/server/onboarding-v2/franchise";
import { listMarketplaceRoles } from "@/server/onboarding-v2/roles";
import { setFeatureFlag } from "@/server/services/feature-flags";
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

describe("free dealer: live at once with a GKD code (DEFAULT #15)", () => {
  it("approved now from the shop's details, DEALER role, role history, idempotent", async () => {
    const o = await shopOwner({ withPan: true });
    const r = await becomeFreeDealer(o.actor);
    expect(r.approvedNow).toBe(true);
    expect(r.code).toMatch(/^GKD-[23456789A-Z]{6}$/);
    const [d] = await db.select().from(dealers).where(eq(dealers.userId, o.user.id));
    expect(d).toMatchObject({ status: "APPROVED", gstin: "27ABCDE1234F1Z5", dealerType: "PROPRIETORSHIP", city: "Pune", pincode: "411001" });
    expect(d.mobileE164).toBe(o.user.phoneE164);
    expect(d.panHash).not.toBeNull(); // the shop's PAN, not asked again
    expect(d.preferredZoneId).toBeNull(); // no area
    const [grant] = await db.select().from(userRoleGrants).where(and(eq(userRoleGrants.userId, o.user.id), eq(userRoleGrants.role, "DEALER")));
    expect(grant.status).toBe("ACTIVE");
    const history = await db.select().from(onboardingRoleHistory).where(eq(onboardingRoleHistory.userId, o.user.id));
    expect(history.map((h) => `${h.role}:${h.action}`)).toEqual(["dealer_free:GRANTED"]);
    expect((await listMarketplaceRoles(o.user.id)).roles).toEqual(expect.arrayContaining(["customer", "dealer_free"]));
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "dealer"), eq(auditLogs.entityId, d.id)));
    expect(audit.some((a) => (a.newValue as { via?: string } | null)?.via === "onboarding_v2_instant")).toBe(true);

    const again = await becomeFreeDealer(o.actor);
    expect(again).toEqual({ dealerId: d.id, code: r.code, approvedNow: false });
    expect(await db.select().from(dealers).where(eq(dealers.userId, o.user.id))).toHaveLength(1);
  });

  it("without a PAN on the shop the dealer is still live; PAN + bank are asked before the first payout only", async () => {
    const o = await shopOwner();
    await becomeFreeDealer(o.actor);
    const s = await franchiseStartState(o.user.id);
    expect(s.isFreeDealer).toBe(true);
    expect(s.payoutMissing).toEqual(["PAN", "payout bank account"]);
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
