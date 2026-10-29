/**
 * Dealer commission, base % model (owner, 29 Oct 2026):
 *   - an admin sets a base commission as a % of the registration fee paid
 *     (before GST, after any coupon), earned in full when the shop is approved
 *   - each 1.0 of rating above 5.0 adds the step (1 percentage point by
 *     default), each 1.0 below takes it off — never below 0%
 *   - the base % and the step can be set for one dealer
 *   - the fixed amounts per milestone are not used
 * The milestone rules model is covered in dealer-step5-commission.test.ts.
 */
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { POST as commissionPost } from "@/app/api/admin/dealer-commission/route";
import { db } from "@/server/db";
import { auditLogs, dealerCommissionLedger, dealerCommissionRules, dealers, sellerVerifications, shopAttributions, shops } from "@/server/db/schema";
import {
  checkCommissionMilestones,
  dealerCommissionRate,
  dealerRateView,
  getCommissionSettings,
  percentCommissionAmount,
  ratingView,
  setCommissionSettings,
  setDealerCommissionRates,
} from "@/server/dealers/commission";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { call } from "../helpers/http";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; email: string; name: string | null; role: "ADMIN" };

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

beforeEach(async () => {
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  // Milestone rules exist (as on the sites) but are not used by the base % model.
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
  // The migration's defaults: base 40%, 1 percentage point per rating point.
  await setCommissionSettings(
    { capPaise: 99_900, catalogueMinProducts: 1, branchEligible: false, commissionModel: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100 },
    "test defaults",
    admin,
  );
  await db.execute(sql`delete from dealer_rating_slabs where min_shops not in (0, 200, 250, 500)`);
  await setFeatureFlag("dealer_programme_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
  await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", admin);
});

async function newDealer(over: Partial<typeof dealers.$inferInsert> = {}) {
  const user = await createUser({ role: "DEALER" });
  const [dealer] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: "Shree Sai", contactName: "Shree Sai", dealerType: "PROPRIETORSHIP", status: "APPROVED", ...over })
    .returning();
  return dealer;
}

/** A pending Pune shop, fee ₹1,000 + GST, attributed to the dealer. */
async function attributedShop(dealerId: string) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: "Ganesh Traders", status: "PENDING_APPROVAL", shopType: "GENERAL_TRADING" as never, registrationFeePaise: 118_000 });
  await db.update(shops).set({ registrationFeeBasePaise: 100_000, registrationFeeDiscountPaise: 0, registrationFeeGstPaise: 18_000 }).where(eq(shops.id, shop.id));
  await db.insert(shopAttributions).values({ shopId: shop.id, dealerId, source: "CODE_AT_REGISTRATION", matchKind: "NONE" });
  return shop;
}

/** Fee paid, documents verified, one product listed, then approved. Returns the ledger entries. */
async function bringLive(shopId: string) {
  await recordPayment({ shopId, paymentType: "REGISTRATION_FEE", amountPaise: 118_000, method: "ONLINE", transactionId: `cf_${shopId.slice(0, 8)}` }, admin);
  for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) {
    await db.insert(sellerVerifications).values({ shopId, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() });
  }
  const category = await createCategory({ department: "GENERAL_TRADING" as never, name: `Stationery ${shopId.slice(0, 4)}` });
  const product = await createProduct(category.id, { name: `Rice ${shopId.slice(0, 4)}` });
  await createShopProduct(shopId, product.id);
  await checkCommissionMilestones(shopId);
  const beforeApproval = await entries(shopId);
  await approveShop(shopId, { classification: "KESARI" }, admin);
  return { beforeApproval, after: await entries(shopId) };
}

const entries = async (shopId: string) => db.select().from(dealerCommissionLedger).where(eq(dealerCommissionLedger.shopId, shopId));

describe("base % of the fee, earned when the shop is approved", () => {
  it("40% of the ₹1,000 fee (before GST) = ₹400, all at approval; nothing at fee payment or verification; no fixed amounts", async () => {
    const dealer = await newDealer();
    const shop = await attributedShop(dealer.id);
    const { beforeApproval, after } = await bringLive(shop.id);
    expect(beforeApproval).toHaveLength(0);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      milestone: "ACTIVATED",
      amountPaise: 40_000,
      feePaise: 100_000,
      basePaise: 40_000,
      bonusBp: 0,
      bonusPaise: 0,
      ruleId: null,
      status: "EARNED",
    });
  });

  it("rating 6.0 → 41% (₹410); rating 4.0 → 39% (₹390), the rating part shown as −1%", async () => {
    const up = await newDealer({ rating: 6, startRating: 6 });
    const upShop = await attributedShop(up.id);
    expect((await bringLive(upShop.id)).after[0]).toMatchObject({ amountPaise: 41_000, basePaise: 40_000, bonusBp: 100, bonusPaise: 1_000 });

    const down = await newDealer({ rating: 4, startRating: 4 });
    const downShop = await attributedShop(down.id);
    expect((await bringLive(downShop.id)).after[0]).toMatchObject({ amountPaise: 39_000, basePaise: 40_000, bonusBp: -100, bonusPaise: -1_000 });
  });

  it("follows the admin's default base % and step; the rating part is off where the bonus flag is off", async () => {
    await setCommissionSettings({ basePercentBp: 2500, ratingStepBp: 200 }, "new default", admin);
    const dealer = await newDealer({ rating: 6.5, startRating: 6.5 });
    const shop = await attributedShop(dealer.id);
    // 25% + 1.5 × 2 points = 28%.
    expect((await bringLive(shop.id)).after[0]).toMatchObject({ amountPaise: 28_000, bonusBp: 300 });

    await setFeatureFlag("dealer_rating_bonus_enabled", { enabled: false, districtCodes: null }, "off (test)", admin);
    const other = await newDealer({ rating: 4, startRating: 4 });
    const otherShop = await attributedShop(other.id);
    expect((await bringLive(otherShop.id)).after[0]).toMatchObject({ amountPaise: 25_000, bonusBp: 0 });
  });

  it("never below 0%: nothing is recorded when the rating takes it all away", async () => {
    await setCommissionSettings({ basePercentBp: 100, ratingStepBp: 200 }, "tiny base", admin);
    const dealer = await newDealer({ rating: 4, startRating: 4 });
    const shop = await attributedShop(dealer.id);
    expect((await bringLive(shop.id)).after).toHaveLength(0);
  });

  it("the per-shop cap still applies: above it waits for an admin override", async () => {
    await setCommissionSettings({ basePercentBp: 10_000 }, "100% for the test", admin);
    const dealer = await newDealer();
    const shop = await attributedShop(dealer.id);
    const rows = (await bringLive(shop.id)).after;
    expect(rows.find((e) => !e.aboveCap)).toMatchObject({ amountPaise: 99_900, status: "EARNED" });
    expect(rows.find((e) => e.aboveCap)).toMatchObject({ amountPaise: 100, status: "PENDING" });
  });
});

describe("one dealer's own base % and step", () => {
  it("a dealer's own 25% and 0.5 points per rating point; another dealer keeps the default; clearing returns to the default", async () => {
    const own = await newDealer({ rating: 6, startRating: 6 });
    const plain = await newDealer({ rating: 6, startRating: 6 });
    await setDealerCommissionRates(own.id, { commissionPercentBp: 2500, ratingStepBp: 50 }, "negotiated rate", admin);

    const ownShop = await attributedShop(own.id);
    expect((await bringLive(ownShop.id)).after[0]).toMatchObject({ amountPaise: 25_500, basePaise: 25_000, bonusBp: 50 });
    const plainShop = await attributedShop(plain.id);
    expect((await bringLive(plainShop.id)).after[0]).toMatchObject({ amountPaise: 41_000 });

    await setDealerCommissionRates(own.id, { commissionPercentBp: null, ratingStepBp: null }, "back to the default", admin);
    const view = await dealerRateView(own.id);
    expect(view).toMatchObject({ model: "BASE_PERCENT", basePercentBp: 4000, ratingStepBp: 100, ownBasePercent: false, ownRatingStep: false });
  });

  it("only an admin sets it, with a reason, audited; operators get 403; out-of-range values are refused", async () => {
    const dealer = await newDealer();
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const denied = await call(commissionPost, "/api/admin/dealer-commission", {
      method: "POST",
      body: { action: "dealerRates", dealerId: dealer.id, commissionPercentBp: 9000, ratingStepBp: null, reason: "operator try" },
    });
    expect(denied.status).toBe(403);
    await expect(setDealerCommissionRates(dealer.id, { commissionPercentBp: 9000, ratingStepBp: null }, "try", { id: operator.id, role: "OPERATOR" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    signIn(admin, "ADMIN");
    const res = await call(commissionPost, "/api/admin/dealer-commission", {
      method: "POST",
      body: { action: "dealerRates", dealerId: dealer.id, commissionPercentBp: 3000, ratingStepBp: 150, reason: "agreed with the dealer" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ dealerId: dealer.id, commissionPercentBp: 3000, ratingStepBp: 150 });
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "dealer.commission_rates_changed"));
    expect(log).toMatchObject({ entityId: dealer.id, previousValue: { commissionPercentBp: null, ratingStepBp: null } });
    expect(log.newValue).toMatchObject({ commissionPercentBp: 3000, ratingStepBp: 150, reason: "agreed with the dealer" });

    for (const [percent, step] of [
      [10_001, null],
      [null, 1001],
      [-1, null],
    ]) {
      await expect(setDealerCommissionRates(dealer.id, { commissionPercentBp: percent, ratingStepBp: step }, "bad value", admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    await expect(setDealerCommissionRates(dealer.id, { commissionPercentBp: 3000, ratingStepBp: null }, "", admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("the admin's defaults are kept in settings and changed only by an admin", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const denied = await call(commissionPost, "/api/admin/dealer-commission", {
      method: "POST",
      body: { action: "settings", patch: { basePercentBp: 9000 }, reason: "operator try" },
    });
    expect(denied.status).toBe(403);
    signIn(admin, "ADMIN");
    const res = await call(commissionPost, "/api/admin/dealer-commission", {
      method: "POST",
      body: { action: "settings", patch: { basePercentBp: 3500, ratingStepBp: 50 }, reason: "new default" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await getCommissionSettings()).toMatchObject({ commissionModel: "BASE_PERCENT", basePercentBp: 3500, ratingStepBp: 50 });
    const bad = await call(commissionPost, "/api/admin/dealer-commission", {
      method: "POST",
      body: { action: "settings", patch: { basePercentBp: 20_000 }, reason: "too much" },
    });
    expect(bad.status).toBe(422);
  });
});

describe("the dealer's view and the maths", () => {
  it("the rating card shows the signed rating part; the rate view shows the dealer's own rate", async () => {
    const dealer = await newDealer({ rating: 4.5, startRating: 4.5 });
    expect((await ratingView(dealer.id)).bonusBp).toBe(-50);
    expect(await dealerRateView(dealer.id)).toMatchObject({ basePercentBp: 4000, adjustmentBp: -50, effectivePercentBp: 3950, ratingOn: true });
  });

  it("splits the amount into the base part and the rating part", () => {
    const rate = dealerCommissionRate({ commissionPercentBp: 2000, ratingStepBp: 100, rating: 6.5 }, { basePercentBp: 4000, ratingStepBp: 100 }, true);
    expect(rate).toMatchObject({ basePercentBp: 2000, adjustmentBp: 150, effectivePercentBp: 2150, ownBasePercent: true, ownRatingStep: true });
    expect(percentCommissionAmount(rate, 99_900)).toEqual({ basePaise: 19_980, bonusBp: 150, bonusPaise: 1_499, totalPaise: 21_479 });
  });
});
