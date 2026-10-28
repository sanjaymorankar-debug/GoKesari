/**
 * Dealer programme step 5 (docs/dealer-programme, GKS-CM-001…003): commission
 * rules, accrual by milestone, the cap, the ledger to payout, reversals, the
 * onboarding rating and its bonus.
 *
 * Scenarios (build prompt §5): 38 fixed; 39 percentage of the fee paid; 40
 * fixed + percentage; 41 a rule change keeps earlier entries' version; 42
 * operator / dealer refused (403); 43 admin change audited with old, new,
 * reason; 44 above the cap held until an override (audited); 45 payout with a
 * reference, reconciled; 46 reversal after payout carried to the next
 * statement; 47 a new dealer at 5.0 earns no bonus; 48/49 slabs; 50 at most
 * 10; 51 a reversal lowers the rating going forward; 52 the bonus on a
 * percentage and a fixed rule; 53 the bonus capped; 54 a starting rating of
 * 6.0; 55 a manual downgrade, seen by the dealer; 56 slabs admin only; plus
 * suspension holds, duplicates and GoKesari Direct earning nothing, and the
 * programme off.
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as commissionPost } from "@/app/api/admin/dealer-commission/route";
import { POST as ratingPost } from "@/app/api/admin/dealers/[id]/rating/route";
import { db } from "@/server/db";
import {
  auditLogs,
  dealerCommissionLedger,
  dealerCommissionRules,
  dealers,
  notifications,
  sellerVerifications,
  shopAttributions,
  shops,
} from "@/server/db/schema";
import {
  approveEntries,
  bonusBpForRating,
  checkCommissionMilestones,
  commissionAmount,
  createPayoutBatch,
  listCommissionRules,
  markPayoutPaid,
  ratingView,
  saveCommissionRule,
  saveRatingSlab,
  setCommissionSettings,
  slabFor,
} from "@/server/dealers/commission";
import { decideDealer } from "@/server/dealers/service";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; email: string; name: string | null; role: "ADMIN" };
const TODAY = new Date().toISOString().slice(0, 10);

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

beforeEach(async () => {
  await resetDatabase();
  // Seed data the reset leaves alone (rules, settings, slabs) back to the migration's defaults.
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionRules);
  await db.insert(dealerCommissionRules).values(
    (["REGISTERED", "VERIFIED_CATALOGUE", "ACTIVATED"] as const).map((milestone, i) => ({
      ruleKey: crypto.randomUUID(),
      version: 1,
      shopScope: "STANDARD" as const,
      milestone,
      fixedPaise: [10_000, 15_000, 15_000][i],
      effectiveFrom: "2026-10-01",
      changeReason: "pilot default (test)",
    })),
  );
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  await setCommissionSettings({ capPaise: 99_900, fixedBonusBase: "FEE", catalogueMinProducts: 1, branchEligible: false }, "test defaults", admin);
  await db.execute(sql`delete from dealer_rating_slabs where min_shops not in (0, 200, 250, 500)`);
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
});

async function newDealer(name = "Shree Sai", over: Partial<typeof dealers.$inferInsert> = {}) {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db.insert(dealers).values({ userId: user.id, legalName: name, contactName: name, dealerType: "PROPRIETORSHIP", status: "APPROVED", ...over }).returning();
  return { user, dealer };
}

/** A pending Pune shop (fee ₹1,000 + GST) attributed to the dealer. */
async function attributedShop(dealerId: string, over: { matchKind?: "NONE" | "DUPLICATE" | "BRANCH" } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Ganesh Traders", status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: 118_000 });
  await db.update(shops).set({ registrationFeeBasePaise: 100_000, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: 18_000 }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, source: "CODE_AT_REGISTRATION", matchKind: over.matchKind ?? "NONE" });
  return shop;
}

const payFee = (shopId: string) => recordPayment({ shopId, paymentType: "REGISTRATION_FEE", amountPaise: 118_000, method: "ONLINE", transactionId: `cf_${shopId.slice(0, 8)}` }, admin);

/** Verified documents and one product: the VERIFIED_CATALOGUE milestone (catalogue size 1 in these tests). */
async function verifyAndList(shopId: string) {
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) await db.insert(sellerVerifications).values({ shopId, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
  const category = await createCategory({ department: "GENERAL_TRADING" as never, name: `Stationery ${shopId.slice(0, 4)}` });
  const product = await createProduct(category.id, { name: `Rice ${shopId.slice(0, 4)}` });
  await createShopProduct(shopId, product.id);
}

const entries = async (shopId: string) => db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shopId));
const amountsByMilestone = async (shopId: string) => Object.fromEntries((await entries(shopId)).filter((e) => !e.aboveCap).map((e) => [e.milestone, e.amountPaise]));

describe("accrual by milestone (scenarios 38, 47)", () => {
  it("₹100 on the fee, ₹150 on verification + catalogue, ₹150 on approval — ₹400; a new dealer at 5.0 earns no bonus", async () => {
    const { dealer } = await newDealer();
    const shop = await attributedShop(dealer.id);
    await payFee(shop.id);
    expect(await amountsByMilestone(shop.id)).toEqual({ REGISTERED: 10_000 });
    await verifyAndList(shop.id);
    await checkCommissionMilestones(shop.id);
    await approveShop(shop.id, { classification: "KESARI" }, admin);
    expect(await amountsByMilestone(shop.id)).toEqual({ REGISTERED: 10_000, VERIFIED_CATALOGUE: 15_000, ACTIVATED: 15_000 });
    const all = await entries(shop.id);
    expect(all.every((e) => e.status === "EARNED" && e.bonusBp === 0 && e.ruleVersion === 1 && e.feePaise === 100_000)).toBe(true);
    // Idempotent: checking again accrues nothing more.
    await checkCommissionMilestones(shop.id);
    expect(await entries(shop.id)).toHaveLength(3);
    const [d] = await db.select().from(dealers).where(eq(dealers.id, dealer.id));
    expect(d).toMatchObject({ activatedShops: 1, rating: 5 });
  });

  it("nothing for a likely duplicate, for GoKesari Direct, or with the programme off", async () => {
    const { dealer } = await newDealer();
    const dup = await attributedShop(dealer.id, { matchKind: "DUPLICATE" });
    await payFee(dup.id);
    expect(await entries(dup.id)).toHaveLength(0);
    const [direct] = await db.insert(dealers).values({ legalName: "GoKesari Direct", contactName: "GK", dealerType: "COMPANY", status: "APPROVED", isInternal: true }).returning();
    const own = await attributedShop(direct.id);
    await payFee(own.id);
    expect(await entries(own.id)).toHaveLength(0);
    await setFeatureFlag("dealer_programme_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
    const off = await attributedShop(dealer.id);
    await payFee(off.id);
    expect(await entries(off.id)).toHaveLength(0);
  });
});

describe("rules (scenarios 39, 40, 41, 42, 43)", () => {
  it("percentage of the fee paid, fixed + percentage, and a change keeps earlier entries on their version", async () => {
    const { dealer } = await newDealer();
    const rules = await listCommissionRules();
    const reg = rules.find((r) => r.milestone === "REGISTERED")!;
    const first = await attributedShop(dealer.id);
    await payFee(first.id);
    expect((await entries(first.id))[0]).toMatchObject({ amountPaise: 10_000, ruleVersion: 1 });

    await saveCommissionRule({ ruleKey: reg.ruleKey, shopScope: "STANDARD", milestone: "REGISTERED", fixedPaise: 0, percentBp: 4000, effectiveFrom: TODAY }, "pilot moves to 40% of the fee", admin);
    const second = await attributedShop(dealer.id);
    await payFee(second.id);
    expect((await entries(second.id))[0]).toMatchObject({ amountPaise: 40_000, ruleVersion: 2, basePaise: 40_000 });

    const v2 = (await listCommissionRules()).find((r) => r.milestone === "REGISTERED")!;
    await saveCommissionRule({ ruleKey: v2.ruleKey, shopScope: "STANDARD", milestone: "REGISTERED", fixedPaise: 5_000, percentBp: 1000, effectiveFrom: TODAY }, "fixed plus percentage", admin);
    const third = await attributedShop(dealer.id);
    await payFee(third.id);
    expect((await entries(third.id))[0]).toMatchObject({ amountPaise: 15_000, ruleVersion: 3 });
    // The first shop's entry did not move.
    expect((await entries(first.id))[0]).toMatchObject({ amountPaise: 10_000, ruleVersion: 1 });

    const [audit] = (await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.commission_rule_changed"))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(audit).toMatchObject({ actorId: admin.id, previousValue: { version: 1, fixedPaise: 10_000, percentBp: 0 } });
    expect(audit.newValue).toMatchObject({ version: 2, percentBp: 4000, reason: "pilot moves to 40% of the fee" });
  });

  it("operators and dealers cannot change commission — route (403) and service", async () => {
    const op = await createUser({ role: "OPERATOR" });
    const { user: dealerUser } = await newDealer();
    const rule = { shopScope: "STANDARD", milestone: "REGISTERED", fixedPaise: 99_000, percentBp: 0, effectiveFrom: TODAY };
    for (const [u, role] of [[op, "OPERATOR"], [dealerUser, "DEALER"]] as const) {
      signIn(u, role);
      expect((await call(commissionPost, "/api/admin/dealer-commission", { method: "POST", body: { action: "saveRule", rule, reason: "raise it" } })).status, role).toBe(403);
      expect((await call(commissionPost, "/api/admin/dealer-commission", { method: "POST", body: { action: "saveSlab", minShops: 1, rating: 10, reason: "max me" } })).status, role).toBe(403);
      await expect(saveCommissionRule(rule as never, "raise it", { id: u.id, role })).rejects.toMatchObject({ status: 403 });
    }
    expect((await listCommissionRules()).every((r) => r.fixedPaise !== 99_000)).toBe(true);
  });
});

describe("cap, approval, payout, reversal (scenarios 44, 45, 46, 53)", () => {
  it("above the cap waits for an override; payout with a reference; a refund after payment is carried to the next payout", async () => {
    await setCommissionSettings({ capPaise: 30_000 }, "tight cap for the test", admin);
    const { user, dealer } = await newDealer();
    const shop = await attributedShop(dealer.id);
    await payFee(shop.id);
    await verifyAndList(shop.id);
    await checkCommissionMilestones(shop.id);
    await approveShop(shop.id, { classification: "KESARI" }, admin);
    const rows = await entries(shop.id);
    // ₹100 + ₹150 fit ₹300; of the last ₹150, ₹50 fits and ₹100 waits.
    expect(rows.filter((r) => !r.aboveCap).reduce((s, r) => s + r.amountPaise, 0)).toBe(30_000);
    const above = rows.find((r) => r.aboveCap)!;
    expect(above).toMatchObject({ amountPaise: 10_000, status: "PENDING" });

    await expect(approveEntries([above.id], admin)).rejects.toMatchObject({ status: 409 });
    await approveEntries(rows.filter((r) => !r.aboveCap).map((r) => r.id), admin);
    await approveEntries([above.id], admin, { capOverride: true, reason: "agreed bonus for the first pilot shop" });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.commission_cap_override"))).toHaveLength(1);

    const batch = await createPayoutBatch(dealer.id, admin);
    expect(batch.totalPaise).toBe(40_000);
    await expect(markPayoutPaid(batch.id, "", admin)).rejects.toMatchObject({ status: 422 });
    await markPayoutPaid(batch.id, "UTR-HDFC-0001", admin);
    expect((await entries(shop.id)).every((r) => r.status === "PAID")).toBe(true);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, user.id), eq(notifications.type, "dealer.payout_paid")))).toHaveLength(1);

    // Refunded after payment: negative entries, owed back from the next payout.
    await recordPayment({ shopId: shop.id, paymentType: "REFUND", amountPaise: 118_000, method: "ONLINE", transactionId: "refund-1" }, admin);
    const reversals = (await entries(shop.id)).filter((r) => r.kind === "REVERSAL");
    expect(reversals.reduce((s, r) => s + r.amountPaise, 0)).toBe(-40_000);
    await expect(createPayoutBatch(dealer.id, admin)).rejects.toMatchObject({ status: 409 });
    const [attr] = await db.select().from(shopAttributions).where(eq(shopAttributions.shopId, shop.id));
    expect(attr.status).toBe("REVERSED");
  });
});

describe("rating and bonus (scenarios 48–55)", () => {
  it("the default slabs: 199 → 5.0, 200 → 5.5, 250 → 6.0, 500 → 6.5; the bonus is (rating − 5) points, never negative", () => {
    const slabs = [
      { minShops: 0, rating: 5 },
      { minShops: 200, rating: 5.5 },
      { minShops: 250, rating: 6 },
      { minShops: 500, rating: 6.5 },
    ];
    expect([0, 199, 200, 249, 250, 499, 500, 10_000].map((n) => slabFor(slabs, n).current.rating)).toEqual([5, 5, 5.5, 5.5, 6, 6, 6.5, 6.5]);
    expect(slabFor(slabs, 199).next).toEqual({ minShops: 200, rating: 5.5 });
    expect([5, 5.5, 6, 6.5, 10, 4.5].map(bonusBpForRating)).toEqual([0, 50, 100, 150, 500, 0]);
  });

  it("the bonus on a percentage rule adds points; on a fixed rule it is figured on the fee or on the fixed amount", () => {
    expect(commissionAmount({ fixedPaise: 0, percentBp: 4000 }, 100_000, 100, "FEE")).toEqual({ basePaise: 40_000, bonusBp: 100, bonusPaise: 1_000, totalPaise: 41_000 });
    expect(commissionAmount({ fixedPaise: 15_000, percentBp: 0 }, 100_000, 100, "FEE")).toMatchObject({ bonusPaise: 1_000, totalPaise: 16_000 });
    expect(commissionAmount({ fixedPaise: 15_000, percentBp: 0 }, 100_000, 100, "BASE_AMOUNT")).toMatchObject({ bonusPaise: 150, totalPaise: 15_150 });
  });

  it("crossing a slab raises the rating for the next accrual only; a reversal lowers it again; the bonus stays within the cap", async () => {
    await saveRatingSlab(1, 6, "test slab: 1 shop → 6.0", admin);
    const { dealer } = await newDealer();
    const first = await attributedShop(dealer.id);
    await payFee(first.id);
    await verifyAndList(first.id);
    await approveShop(first.id, { classification: "KESARI" }, admin);
    expect((await ratingView(dealer.id)).rating).toBe(6);
    // The first shop's entries were earned at 5.0 and stay so.
    expect((await entries(first.id)).every((e) => e.bonusBp === 0)).toBe(true);
    const second = await attributedShop(dealer.id);
    await payFee(second.id);
    expect((await entries(second.id))[0]).toMatchObject({ rating: 6, bonusBp: 100, bonusPaise: 1_000, amountPaise: 11_000 });

    await recordPayment({ shopId: first.id, paymentType: "REFUND", amountPaise: 118_000, method: "ONLINE", transactionId: "refund-2" }, admin);
    expect((await ratingView(dealer.id)).rating).toBe(5);

    // A bonus that would break the cap is cut at the cap.
    await setCommissionSettings({ capPaise: 10_500 }, "cap test", admin);
    await db.update(dealers).set({ rating: 6, startRating: 6 }).where(eq(dealers.id, dealer.id));
    const third = await attributedShop(dealer.id);
    await payFee(third.id);
    const rows = await entries(third.id);
    expect(rows.find((r) => !r.aboveCap)!.amountPaise).toBe(10_500);
    expect(rows.find((r) => r.aboveCap)).toMatchObject({ amountPaise: 500, status: "PENDING" });
  });

  it("an admin sets a starting rating of 6.0 (audited) and lowers a rating with a reason the dealer sees; others cannot", async () => {
    const { user, dealer } = await newDealer();
    signIn(admin, "ADMIN");
    const start = await call(ratingPost, `/api/admin/dealers/${dealer.id}/rating`, { method: "POST", params: { id: dealer.id }, body: { action: "START", rating: 6, reason: "proven distributor in Kothrud" } });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect(start.body.rating).toMatchObject({ rating: 6, bonusBp: 100, startRating: 6 });
    const shop = await attributedShop(dealer.id);
    await payFee(shop.id);
    expect((await entries(shop.id))[0]).toMatchObject({ bonusBp: 100, amountPaise: 11_000 });

    const down = await call(ratingPost, `/api/admin/dealers/${dealer.id}/rating`, { method: "POST", params: { id: dealer.id }, body: { action: "DOWNGRADE", rating: 5, reason: "three registrations with wrong documents" } });
    expect(down.body.rating).toMatchObject({ rating: 5, override: { rating: 5 } });
    const [note] = await db.select().from(notifications).where(and(eq(notifications.userId, user.id), eq(notifications.type, "dealer.rating_changed")));
    expect(note.body).toContain("three registrations with wrong documents");
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.rating_changed"))).not.toHaveLength(0);

    const op = await createUser({ role: "OPERATOR" });
    signIn(op, "OPERATOR");
    expect((await call(ratingPost, `/api/admin/dealers/${dealer.id}/rating`, { method: "POST", params: { id: dealer.id }, body: { action: "START", rating: 10, reason: "try" } })).status).toBe(403);
    await expect(saveRatingSlab(10, 10.5, "too high", admin)).rejects.toMatchObject({ status: 422 });
  });
});

describe("suspension (scenario 5, commission side)", () => {
  it("a suspended dealer's open entries go on hold; reactivation releases them", async () => {
    const { dealer } = await newDealer();
    const shop = await attributedShop(dealer.id);
    await payFee(shop.id);
    await decideDealer(dealer.id, { action: "SUSPEND", reason: "documents being re-checked" }, admin);
    expect((await entries(shop.id))[0]).toMatchObject({ status: "ON_HOLD", heldFromStatus: "EARNED" });
    await decideDealer(dealer.id, { action: "REACTIVATE", reason: "documents fine" }, admin);
    expect((await entries(shop.id))[0]).toMatchObject({ status: "EARNED", heldFromStatus: null });
  });
});
