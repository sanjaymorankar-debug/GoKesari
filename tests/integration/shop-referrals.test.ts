/**
 * Shop-refers-shop (owner brief, 2 Nov 2026; docs/dealer-programme/TIERED_COMMISSION.md Part B),
 * against real PostgreSQL — runs on both layouts (CI job test-split):
 *   - every approved shop has its own code; off → none
 *   - a registering shop enters one code (dealer or shop, the first one kept); the referred shop's
 *     10% discount on the ₹999 / ₹4,999 / ₹9,999 slabs, or a welcome credit
 *   - the referring shop's reward (promotional credit or a membership extension) once the new shop
 *     is approved and its first order delivered — idempotent
 *   - guards: same owner, PAN, GSTIN, mobile or bank account; a branch or a duplicate; the yearly cap
 *   - promotional credit pays commission / delivery only, never a manual debit; admin reversal
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { encryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { bankAccounts, orders, sellerVerifications, shopReferrals, shopWallets, shops, type Shop } from "@/server/db/schema";
import { RULES, type RuleValue } from "@/server/config/rules";
import { updateOrderStatus } from "@/server/services/orders";
import { assertRegistrationReferralCode } from "@/server/services/referral-requests";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { answerDraftReferral } from "@/server/services/shop-registration-wizard";
import { getOrCreateShopReferralCode, listShopReferrals, reverseShopReferral, shopReferralSummary } from "@/server/services/shop-referrals";
import { applyShopWalletEntry } from "@/server/services/shop-wallet";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop, registerShop } from "@/server/services/shops";
import { createOrder, createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: "ADMIN" };
let counter = 0;

async function enable(over: Partial<RuleValue<"shopReferrals">> = {}) {
  await setRule("shopReferrals", { ...RULES.shopReferrals.defaults, enabled: true, ...over }, admin);
  clearRuleCache();
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`delete from platform_settings where key = 'shopReferrals'`);
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await enable();
});

/** An approved shop that refers others, with its code. */
async function referrer(over: Partial<typeof shops.$inferInsert> = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { name: `Referrer Mart ${(counter += 1)}`, status: "APPROVED", latitude: 18.52, longitude: 73.85 });
  await db.update(shops).set({ phone: `98${String(10_000_000 + counter)}`, pincode: "411030", ...over }).where(eq(shops.id, shop.id));
  const code = await getOrCreateShopReferralCode(shop.id);
  return { shop, owner, code: code! };
}

/** A new shop registered by its owner with `code`, on the turnover slab giving that base fee. */
async function registerWith(code: string | null, turnoverRupees = 10_00_000, ownerId?: string) {
  counter += 1;
  const owner = ownerId ? { id: ownerId } : await createUser({ role: "CUSTOMER" });
  return registerShop(
    {
      name: `New Kirana ${counter} ${randomUUID().slice(0, 4)}`,
      ownerName: "New Owner",
      phone: `97${String(10_000_000 + counter)}`,
      addressLine1: `${counter} Station Road`,
      city: "Pune",
      pincode: "411001",
      shopType: "GENERAL_TRADING",
      annualTurnoverRupees: turnoverRupees,
      referralCode: code,
    },
    { id: owner.id, role: "CUSTOMER" },
  );
}

/** The new shop is approved and delivers its first order. */
async function goLiveAndDeliver(shop: Pick<Shop, "id">) {
  const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
  if (row.status !== "APPROVED") {
    if (Number(row.registrationFeePaise) > 0) {
      await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: Number(row.registrationFeePaise), method: "ONLINE", transactionId: `cf_${shop.id.slice(0, 8)}` }, admin);
    }
    for (const docType of ["PAN", "GSTIN", "SHOP_ACT"] as const) {
      await db.insert(sellerVerifications).values({ shopId: shop.id, docType, status: "VERIFIED", providerId: "mock", verifiedAt: new Date() }).onConflictDoNothing();
    }
    await approveShop(shop.id, { classification: "KESARI" }, admin);
  }
  const buyer = await createUser();
  const order = await createOrder(buyer.id, shop.id, { status: "OUT_FOR_DELIVERY" });
  await db.update(orders).set({ deliveryAddressSnapshot: { line1: "5 Buyer Lane", city: "Pune", pincode: "411001" } }).where(eq(orders.id, order.id));
  await updateOrderStatus(order.id, "DELIVERED", admin);
  return order;
}

const referralOf = async (shopId: string) => (await db.select().from(shopReferrals).where(eq(shopReferrals.referredShopId, shopId)))[0];
const wallet = async (shopId: string) => (await db.select().from(shopWallets).where(eq(shopWallets.shopId, shopId)))[0];

describe("codes", () => {
  it("an approved shop gets one stable SHOP code; a pending shop none; none while the rule is off", async () => {
    const r = await referrer();
    expect(r.code).toMatch(/^SHOP[A-HJ-NP-Z2-9]{5}$/);
    expect(await getOrCreateShopReferralCode(r.shop.id)).toBe(r.code);
    const owner = await createUser({ role: "SHOP_OWNER" });
    const pending = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    expect(await getOrCreateShopReferralCode(pending.id)).toBeNull();
    await enable({ enabled: false });
    expect(await shopReferralSummary(r.shop.id)).toMatchObject({ enabled: false, code: null });
  });
});

describe("registration with a shop code", () => {
  it.each([
    [10_00_000, 99_900, 9_990],
    [5_00_00_000, 499_900, 49_990],
    [20_00_00_000, 999_900, 99_990],
  ])("turnover ₹%i: 10%% off the ₹%i paise fee (%i), before GST; recorded PENDING; never a dealer attribution", async (turnover, base, off) => {
    const r = await referrer();
    const shop = await registerWith(r.code, turnover);
    const [row] = await db.select().from(shops).where(eq(shops.id, shop.id));
    expect(row).toMatchObject({ registrationFeeBasePaise: base, registrationFeeDiscountPaise: off, referralCodeId: null });
    expect(Number(row.registrationFeeGstPaise)).toBe(Math.round(((base - off) * Number(row.registrationFeeGstRateBp)) / 10_000));
    expect(await referralOf(shop.id)).toMatchObject({ referrerShopId: r.shop.id, status: "PENDING", referredMode: "DISCOUNT", discountPaise: off });
  });

  it("wallet-credit mode: no discount, a welcome credit at the reward instead", async () => {
    await enable({ referredMode: "WALLET_CREDIT", referredCreditPaise: 10_000 });
    const r = await referrer();
    const shop = await registerWith(r.code);
    expect((await db.select().from(shops).where(eq(shops.id, shop.id)))[0].registrationFeeDiscountPaise).toBe(0);
    await goLiveAndDeliver(shop);
    expect(await referralOf(shop.id)).toMatchObject({ status: "REWARDED", referredRewardPaise: 10_000, referrerRewardPaise: 20_000 });
    expect(await wallet(shop.id)).toMatchObject({ balancePaise: 10_000, promoBalancePaise: 10_000 });
  });

  it("rule off: a SHOP code is not a valid referral code and gives nothing", async () => {
    const r = await referrer();
    await enable({ enabled: false });
    await expect(assertRegistrationReferralCode(r.code)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const shop = await registerWith(r.code);
    expect(await referralOf(shop.id)).toBeUndefined();
    expect((await db.select().from(shops).where(eq(shops.id, shop.id)))[0].registrationFeeDiscountPaise).toBe(0);
  });

  it("one code: the wizard keeps the first code entered and refuses another", async () => {
    const r = await referrer();
    const other = await referrer();
    const owner = await createUser({ role: "CUSTOMER" });
    const actor = { id: owner.id, role: "CUSTOMER" as const };
    expect((await answerDraftReferral({ actor, referralCode: r.code })).referral).toMatchObject({ code: r.code, locked: true });
    await expect(answerDraftReferral({ actor, referralCode: other.code })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "REFERRAL_CODE_LOCKED" } });
    expect((await answerDraftReferral({ actor, referralCode: r.code })).referral.code).toBe(r.code);
  });
});

describe("the reward", () => {
  it("₹200 promotional credit to the referring shop when the new shop is approved and its first order delivered — once", async () => {
    const r = await referrer();
    const shop = await registerWith(r.code);
    await goLiveAndDeliver(shop);
    expect(await referralOf(shop.id)).toMatchObject({ status: "REWARDED", referrerRewardKind: "WALLET_CREDIT", referrerRewardPaise: 20_000 });
    expect(await wallet(r.shop.id)).toMatchObject({ balancePaise: 20_000, promoBalancePaise: 20_000 });
    // A second delivery changes nothing.
    const buyer = await createUser();
    const again = await createOrder(buyer.id, shop.id, { status: "OUT_FOR_DELIVERY" });
    await updateOrderStatus(again.id, "DELIVERED", admin);
    expect(await wallet(r.shop.id)).toMatchObject({ balancePaise: 20_000 });
    expect(await shopReferralSummary(r.shop.id)).toMatchObject({ rewarded: 1, earnedPaise: 20_000 });
  });

  it("membership extension mode: one month more; the reversal takes it off again", async () => {
    await enable({ referrerMode: "MEMBERSHIP_EXTENSION", referrerExtensionMonths: 1 });
    const until = new Date("2027-06-15T00:00:00Z");
    const r = await referrer({ membershipValidUntil: until });
    const shop = await registerWith(r.code);
    await goLiveAndDeliver(shop);
    const row = await referralOf(shop.id);
    expect(row).toMatchObject({ status: "REWARDED", referrerRewardKind: "MEMBERSHIP_EXTENSION", referrerExtensionMonths: 1, referrerRewardPaise: 0 });
    const [extended] = await db.select().from(shops).where(eq(shops.id, r.shop.id));
    expect(extended.membershipValidUntil?.toISOString().slice(0, 10)).toBe("2027-07-15");
    await reverseShopReferral(row.id, "found to be the same owner's family", admin);
    const [back] = await db.select().from(shops).where(eq(shops.id, r.shop.id));
    expect(back.membershipValidUntil?.toISOString().slice(0, 10)).toBe("2027-06-15");
  });

  it.each([
    ["owner", "Same owner account"],
    ["pan", "Same PAN"],
    ["gstin", "Same GSTIN"],
    ["mobile", "Same mobile number"],
    ["bank", "Same bank account"],
  ])("no reward when the two shops share the %s", async (what, reason) => {
    const r = await referrer({ gstin: "27ABCDE1234F1Z5", panHash: "pan-hash-shared" });
    const shop = await registerWith(r.code, 10_00_000, what === "owner" ? r.owner.id : undefined);
    if (what === "pan") await db.update(shops).set({ panHash: "pan-hash-shared" }).where(eq(shops.id, shop.id));
    if (what === "gstin") await db.update(shops).set({ gstin: "27ABCDE1234F1Z5" }).where(eq(shops.id, shop.id));
    if (what === "mobile") await db.update(shops).set({ contactPhone: (await db.select().from(shops).where(eq(shops.id, r.shop.id)))[0].phone }).where(eq(shops.id, shop.id));
    if (what === "bank") {
      for (const s of [r.shop, shop]) {
        const [o] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, s.id));
        await db.insert(bankAccounts).values({ userId: o.ownerId, shopId: s.id, holderType: "SHOP", method: "BANK_ACCOUNT", accountHolderName: "Same Account", accountNumberEncrypted: encryptSecret("123456789012"), accountNumberLast4: "9012", ifsc: "SBIN0001234" });
      }
    }
    await goLiveAndDeliver(shop);
    const row = await referralOf(shop.id);
    expect(row.status).toBe("REJECTED");
    expect(row.rejectionReason).toContain(reason);
    expect(await wallet(r.shop.id)).toBeUndefined();
  });

  it("no reward when the new shop looks like a duplicate (similar name nearby)", async () => {
    const r = await referrer();
    const twin = await createShop((await createUser({ role: "SHOP_OWNER" })).id, { name: "Ganesh Kirana Stores", status: "APPROVED", latitude: 18.5204, longitude: 73.8567 });
    const shop = await registerWith(r.code);
    await db.update(shops).set({ name: "Ganesh Kirana Store", latitude: "18.5205", longitude: "73.8568", pincode: twin.pincode }).where(eq(shops.id, shop.id));
    await goLiveAndDeliver(shop);
    const row = await referralOf(shop.id);
    expect(row.status).toBe("REJECTED");
    expect(row.rejectionReason).toMatch(/duplicate|branch/);
  });

  it("at most maxRewardsPerYear rewards per referring shop: the next one is decided without a reward", async () => {
    await enable({ maxRewardsPerYear: 1 });
    const r = await referrer();
    const first = await registerWith(r.code);
    const second = await registerWith(r.code);
    await goLiveAndDeliver(first);
    await goLiveAndDeliver(second);
    expect(await referralOf(first.id)).toMatchObject({ status: "REWARDED", referrerRewardPaise: 20_000 });
    const capped = await referralOf(second.id);
    expect(capped).toMatchObject({ status: "REWARDED", referrerRewardPaise: 0, referrerRewardKind: null });
    expect(capped.rejectionReason).toMatch(/already had 1 rewards/);
    expect(await wallet(r.shop.id)).toMatchObject({ balancePaise: 20_000 });
  });
});

describe("promotional credit and reversal", () => {
  it("pays commission and delivery charges, never a manual debit (nothing leaves to a bank)", async () => {
    const r = await referrer();
    const shop = await registerWith(r.code);
    await goLiveAndDeliver(shop);
    await expect(
      applyShopWalletEntry({ shopId: r.shop.id, type: "MANUAL_DEBIT", amountPaise: 5_000, reason: "refund to bank", idempotencyKey: `t-${randomUUID()}` }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    const buyer = await createUser();
    const order = await createOrder(buyer.id, r.shop.id, { status: "DELIVERED" });
    await applyShopWalletEntry({ shopId: r.shop.id, type: "COMMISSION", amountPaise: 3_000, reason: "commission", idempotencyKey: `c-${randomUUID()}`, orderId: order.id, allowNegative: true });
    expect(await wallet(r.shop.id)).toMatchObject({ balancePaise: 17_000, promoBalancePaise: 17_000 });
    // A cash top-up can be debited; the promotional part stays.
    await applyShopWalletEntry({ shopId: r.shop.id, type: "TOP_UP", amountPaise: 10_000, reason: "top-up", idempotencyKey: `u-${randomUUID()}` });
    await applyShopWalletEntry({ shopId: r.shop.id, type: "MANUAL_DEBIT", amountPaise: 10_000, reason: "refund to bank", idempotencyKey: `d-${randomUUID()}` });
    expect(await wallet(r.shop.id)).toMatchObject({ balancePaise: 17_000, promoBalancePaise: 17_000 });
  });

  it("an admin reverses a reward: the unspent promotional credit is taken back; repeating changes nothing; others are refused", async () => {
    const r = await referrer();
    const shop = await registerWith(r.code);
    await goLiveAndDeliver(shop);
    const row = await referralOf(shop.id);
    await expect(reverseShopReferral(row.id, "fraud ring", { id: admin.id, role: "OPERATOR" })).rejects.toThrow(/admin/);
    const reversed = await reverseShopReferral(row.id, "fraud ring found by risk", admin);
    expect(reversed).toMatchObject({ status: "REVERSED", referrerRecoveredPaise: 20_000 });
    expect(await wallet(r.shop.id)).toMatchObject({ balancePaise: 0, promoBalancePaise: 0 });
    expect(await reverseShopReferral(row.id, "fraud ring found by risk", admin)).toMatchObject({ status: "REVERSED" });
    expect((await listShopReferrals())[0]).toMatchObject({ status: "REVERSED", referrerName: expect.stringContaining("Referrer Mart") });
  });
});
