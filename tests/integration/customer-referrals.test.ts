/**
 * F11 — customer referral rewards: a friend who joins with a customer's code
 * earns both of them wallet credit when their first order is delivered;
 * self-referral and duplicate-account signals are refused.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { addresses, customerReferrals, orders, platformSettings, users, walletTransactions, wallets } from "@/server/db/schema";
import {
  applyReferralCode,
  canApplyReferralCode,
  getOrCreateReferralCode,
  getReferralSummary,
  reverseCustomerReferral,
} from "@/server/services/customer-referrals";
import { updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { applyWalletMutation } from "@/server/services/wallet";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(eq(platformSettings.key, "customerReferrals"));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
});

async function enable(overrides: Partial<{ referrerRewardPaise: number; refereeRewardPaise: number; maxRewardsPerReferrer: number }> = {}) {
  await setRule(
    "customerReferrals",
    { enabled: true, referrerRewardPaise: 5000, refereeRewardPaise: 3000, maxRewardsPerReferrer: 20, applyWithinDays: 30, ...overrides },
    admin,
  );
}

async function referrer() {
  const user = await createUser();
  await db.update(users).set({ createdAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(users.id, user.id));
  await db.insert(addresses).values({ userId: user.id, line1: "9 Referrer Road", city: "Pune", pincode: "411001", isDefault: true, addressType: "HOME" });
  return user;
}

const shopOwner = async () => (await createUser({ role: "SHOP_OWNER" })).id;
const promo = async (userId: string) => (await db.query.wallets.findFirst({ where: eq(wallets.userId, userId) }))?.promotionalBalancePaise ?? 0;

async function deliverOrderFor(userId: string, line1 = "5 Friend Street") {
  const shop = await createShop(await shopOwner());
  const order = await createOrder(userId, shop.id, { status: "OUT_FOR_DELIVERY" });
  await db
    .update(orders)
    .set({ deliveryAddressSnapshot: { line1, city: "Pune", pincode: "411001" } })
    .where(eq(orders.id, order.id));
  await updateOrderStatus(order.id, "DELIVERED", admin);
  return order;
}

describe("customer referrals", () => {
  it("gives every customer one stable code", async () => {
    const u = await createUser();
    const code = await getOrCreateReferralCode(u.id);
    expect(code).toMatch(/^GK[A-Z2-9]{6}$/);
    expect(await getOrCreateReferralCode(u.id)).toBe(code);
  });

  it("is refused while switched off, and never rewards then", async () => {
    const r = await referrer();
    const friend = await createUser();
    await expect(applyReferralCode(friend.id, await getOrCreateReferralCode(r.id))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await deliverOrderFor(friend.id);
    expect(await promo(r.id)).toBe(0);
  });

  it("rewards both on the friend's first delivered order, once", async () => {
    await enable();
    const r = await referrer();
    const friend = await createUser();
    expect(await canApplyReferralCode(friend.id)).toBe(true);
    await applyReferralCode(friend.id, (await getOrCreateReferralCode(r.id)).toLowerCase());
    expect(await canApplyReferralCode(friend.id)).toBe(false);

    await deliverOrderFor(friend.id);
    expect(await promo(r.id)).toBe(5000);
    expect(await promo(friend.id)).toBe(3000);

    await deliverOrderFor(friend.id); // a second delivered order pays nothing more
    expect(await promo(r.id)).toBe(5000);
    expect(await getReferralSummary(r.id)).toMatchObject({ rewarded: 1, earnedPaise: 5000 });
  });

  it("refuses self-referral, a second code, and customers who already ordered", async () => {
    await enable();
    const r = await referrer();
    const code = await getOrCreateReferralCode(r.id);
    await expect(applyReferralCode(r.id, code)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    const friend = await createUser();
    await applyReferralCode(friend.id, code);
    const other = await referrer();
    await expect(applyReferralCode(friend.id, await getOrCreateReferralCode(other.id))).rejects.toMatchObject({ code: "CONFLICT" });

    const veteran = await createUser();
    await createOrder(veteran.id, (await createShop(await shopOwner())).id);
    await expect(applyReferralCode(veteran.id, code)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(applyReferralCode((await createUser()).id, "NOPE123")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses an account older than the referrer (not a new customer)", async () => {
    await enable();
    const older = await createUser();
    await db.update(users).set({ createdAt: new Date(Date.now() - 20 * 86_400_000) }).where(eq(users.id, older.id));
    const r = await referrer(); // joined 10 days ago, after `older`
    await expect(applyReferralCode(older.id, await getOrCreateReferralCode(r.id))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("withholds the reward on duplicate-account signals", async () => {
    await enable();
    const r = await referrer();
    const code = await getOrCreateReferralCode(r.id);

    // Delivered to the referrer's own address.
    const sameHome = await createUser();
    await applyReferralCode(sameHome.id, code);
    await deliverOrderFor(sameHome.id, "9, Referrer Road");
    const [row] = await db.select().from(customerReferrals).where(eq(customerReferrals.refereeUserId, sameHome.id));
    expect(row).toMatchObject({ status: "REJECTED", rejectionReason: "Delivered to the referrer's own address." });
    expect(await promo(r.id)).toBe(0);

    // A mobile number that already earned a reward (account re-created).
    const first = await createUser({ mobile: "9876500001" });
    await applyReferralCode(first.id, code);
    await deliverOrderFor(first.id);
    expect(await promo(first.id)).toBe(3000);
    await db.update(users).set({ phoneE164: null, phone: null, deletedAt: new Date() }).where(eq(users.id, first.id));
    const again = await createUser({ mobile: "9876500001" });
    await applyReferralCode(again.id, code);
    await deliverOrderFor(again.id, "77 Elsewhere");
    expect(await promo(again.id)).toBe(0);
    const [second] = await db.select().from(customerReferrals).where(eq(customerReferrals.refereeUserId, again.id));
    expect(second.status).toBe("REJECTED");
  });

  it("caps what one referrer can earn", async () => {
    await enable({ maxRewardsPerReferrer: 1 });
    const r = await referrer();
    const code = await getOrCreateReferralCode(r.id);
    for (const line of ["1 A St", "2 B St"]) {
      const friend = await createUser();
      await applyReferralCode(friend.id, code);
      await deliverOrderFor(friend.id, line);
      expect(await promo(friend.id)).toBe(3000);
      expect(await promo(r.id)).toBe(5000); // only the first counts for the referrer
    }
  });
});

describe("D-25: reversing a rewarded referral found fraudulent", () => {
  it("takes both rewards back as REVERSAL entries, never below zero, once", async () => {
    await enable();
    const r = await referrer();
    const friend = await createUser();
    await applyReferralCode(friend.id, await getOrCreateReferralCode(r.id));
    await expect(reverseCustomerReferral((await db.query.customerReferrals.findFirst())!.id, "Same device as the referrer", admin)).rejects.toMatchObject({
      code: "CONFLICT", // still pending: nothing to reverse
    });
    await deliverOrderFor(friend.id);
    // The referrer has already spent 3,000 of the 5,000 credit.
    await applyWalletMutation({ userId: r.id, amountPaise: 3000, type: "PRODUCT_PURCHASE", idempotencyKey: "spent", description: "order" });

    const [referral] = await db.select().from(customerReferrals).where(eq(customerReferrals.refereeUserId, friend.id));
    await expect(reverseCustomerReferral(referral.id, "no", admin)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const reversed = await reverseCustomerReferral(referral.id, "Same device as the referrer", admin);
    expect(reversed).toMatchObject({ status: "REVERSED", reversedBy: admin.id, referrerRecoveredPaise: 2000, refereeRecoveredPaise: 3000 });
    expect(await promo(r.id)).toBe(0);
    expect(await promo(friend.id)).toBe(0);

    const reversals = await db.select().from(walletTransactions).where(eq(walletTransactions.type, "REVERSAL"));
    expect(reversals.map((t) => t.amountPaise).sort((a, b) => a - b)).toEqual([-3000, -2000]);
    for (const t of reversals) {
      const [original] = await db.select().from(walletTransactions).where(eq(walletTransactions.id, t.reversalOfId!));
      expect(original).toMatchObject({ type: "PROMOTIONAL_CREDIT", userId: t.userId });
    }

    // A second call changes nothing.
    await reverseCustomerReferral(referral.id, "Same device as the referrer", admin);
    expect(await db.select().from(walletTransactions).where(eq(walletTransactions.type, "REVERSAL"))).toHaveLength(2);
    expect(await getReferralSummary(r.id)).toMatchObject({ rewarded: 0, earnedPaise: 0 });
  });

  it("keeps the friend's mobile used: a new account on it earns nothing", async () => {
    await enable();
    const r = await referrer();
    const friend = await createUser();
    await db.update(users).set({ phoneE164: "+919800000001" }).where(eq(users.id, friend.id));
    await applyReferralCode(friend.id, await getOrCreateReferralCode(r.id));
    await deliverOrderFor(friend.id);
    const [referral] = await db.select().from(customerReferrals).where(eq(customerReferrals.refereeUserId, friend.id));
    await reverseCustomerReferral(referral.id, "Fake account farm", admin);

    await db.update(users).set({ phoneE164: null }).where(eq(users.id, friend.id));
    const again = await createUser();
    await db.update(users).set({ phoneE164: "+919800000001" }).where(eq(users.id, again.id));
    await applyReferralCode(again.id, await getOrCreateReferralCode(r.id));
    await deliverOrderFor(again.id, "7 Other Lane");
    const [second] = await db.select().from(customerReferrals).where(eq(customerReferrals.refereeUserId, again.id));
    expect(second).toMatchObject({ status: "REJECTED", rejectionReason: expect.stringMatching(/already earned/) });
    expect(await promo(again.id)).toBe(0);
  });
});
