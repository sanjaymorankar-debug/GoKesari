/**
 * Shop-refers-shop (owner brief, 2 Nov 2026; docs/dealer-programme/TIERED_COMMISSION.md, Part B),
 * the shop version of the customer referral reward (F11, customer-referrals.ts).
 *
 * Every APPROVED shop has its own code ("SHOP" + 5 letters/digits, created on
 * first use) and link (/r/CODE, which sends a shop code to Add my shop). A
 * registering shop enters one code — a dealer / GoKesari code or a shop code,
 * never both (it is one field, and the first code entered is kept). With rule
 * shopReferrals on:
 *
 *   referred shop   referredDiscountBp off the registration fee (referredMode
 *                   DISCOUNT, taken at registration, after any coupon) or
 *                   referredCreditPaise of promotional wallet credit
 *                   (WALLET_CREDIT, at the reward)
 *   referring shop  referrerCreditPaise of promotional wallet credit
 *                   (WALLET_CREDIT) or referrerExtensionMonths more membership
 *                   (MEMBERSHIP_EXTENSION)
 *
 * The reward is decided once, when the referred shop is APPROVED and its first
 * order is DELIVERED (the order-delivered hook, inside that transaction under a
 * savepoint). Promotional credit pays GoKesari commission and delivery charges
 * only and is never paid out to a bank (shop_wallets.promo_balance_paise).
 * Guards: no reward when the two shops share a PAN, GSTIN, mobile, bank account
 * or owner; when the new shop looks like a branch or a duplicate of another
 * shop (the dealer programme's check); when the new shop was attributed to a
 * dealer after all; and at most maxRewardsPerYear rewards per referring shop
 * in 12 months. Rewards are idempotent (wallet idempotency keys). An admin can
 * reverse a reward (reverseShopReferral), as D-25 does for customers.
 */
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

import { SHOP_REFERRAL_CODE_PATTERN } from "@/lib/dealer-tiers";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { decryptSecret } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import { bankAccounts, orders, shopAttributions, shopReferralCodes, shopReferrals, shopWalletTransactions, shopWallets, shops, type Shop, type ShopReferral, type UserRole } from "@/server/db/schema";
import { findLikelyDuplicate } from "@/server/dealers/attribution";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";
import { addMonths } from "./shop-membership";
import { applyShopWalletEntry } from "./shop-wallet";

interface Actor {
  id: string;
  role: UserRole;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const randomCode = () => "SHOP" + Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
export const normalizeShopCode = (code: string | null | undefined) => (code ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
export const looksLikeShopCode = (code: string | null | undefined) => SHOP_REFERRAL_CODE_PATTERN.test(normalizeShopCode(code));

export const shopReferralRule = () => getRule("shopReferrals");

/** The referred shop's discount on its base registration fee (DISCOUNT mode); never more than the fee. */
export function shopReferralDiscount(basePaise: number, rule: { referredMode: string; referredDiscountBp: number }): number {
  if (rule.referredMode !== "DISCOUNT") return 0;
  return Math.max(0, Math.min(basePaise, Math.floor((basePaise * rule.referredDiscountBp) / 10_000)));
}

/** The shop's own code, created on first use. Only for an approved shop, while the rule is on. */
export async function getOrCreateShopReferralCode(shopId: string): Promise<string | null> {
  if (!(await shopReferralRule()).enabled) return null;
  const existing = await db.query.shopReferralCodes.findFirst({ where: eq(shopReferralCodes.shopId, shopId) });
  if (existing) return existing.code;
  const [shop] = await db.select({ status: shops.status, deletedAt: shops.deletedAt }).from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.status !== "APPROVED" || shop.deletedAt) return null;
  for (let attempt = 0; attempt < 6; attempt++) {
    // shop_referral_codes has two unique keys (shop, code): no target, so a clash on either is "nothing inserted".
    const [row] = await db.insert(shopReferralCodes).values({ shopId, code: randomCode() }).onConflictDoNothing().returning();
    if (row) return row.code;
    const mine = await db.query.shopReferralCodes.findFirst({ where: eq(shopReferralCodes.shopId, shopId) });
    if (mine) return mine.code;
  }
  throw new Error("Could not allocate a shop referral code.");
}

/** The shop behind a code — approved and not closed — or a "not valid" error. */
export async function resolveShopReferralCode(raw: string, client: DbClient = db): Promise<{ code: string; shop: Shop }> {
  const code = normalizeShopCode(raw);
  if (!SHOP_REFERRAL_CODE_PATTERN.test(code)) throw validationFailed("That referral code isn't valid.");
  const [row] = await client.select({ shop: shops }).from(shopReferralCodes).innerJoin(shops, eq(shops.id, shopReferralCodes.shopId)).where(eq(shopReferralCodes.code, code));
  if (!row || row.shop.status !== "APPROVED" || row.shop.deletedAt) throw validationFailed(`Referral code ${code} isn't valid.`);
  return { code, shop: row.shop };
}

/**
 * Inside registerShop's transaction: records the referral of the new shop,
 * with the discount it was given. Refuses the shop's own owner's code.
 */
export async function recordShopReferral(tx: DbClient, input: { referredShop: Shop; code: string; discountPaise: number; actor: Actor }): Promise<ShopReferral | null> {
  const rule = await shopReferralRule();
  if (!rule.enabled) return null;
  const { shop: referrer, code } = await resolveShopReferralCode(input.code, tx);
  if (referrer.id === input.referredShop.id) throw validationFailed("A shop can't use its own referral code.");
  const [row] = await tx
    .insert(shopReferrals)
    .values({ referrerShopId: referrer.id, referredShopId: input.referredShop.id, code, referredMode: rule.referredMode, discountPaise: input.discountPaise })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await recordAudit(
    {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: AUDIT_ACTIONS.SHOP_REFERRAL_APPLIED,
      entityType: "shop_referral",
      entityId: row.id,
      newValue: { referrerShopId: referrer.id, referredShopId: input.referredShop.id, code, referredMode: rule.referredMode, discountPaise: input.discountPaise },
    },
    tx,
  );
  return row;
}

/* ================================================================ reward */

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "").slice(-10);

/** Why the two shops are one business (no reward), or null. */
async function sameBusiness(tx: DbClient, a: Shop, b: Shop): Promise<string | null> {
  if (a.ownerId === b.ownerId) return "Same owner account as the referring shop.";
  if (a.panHash && a.panHash === b.panHash) return "Same PAN as the referring shop.";
  if (a.gstin && b.gstin && a.gstin.toUpperCase() === b.gstin.toUpperCase()) return "Same GSTIN as the referring shop.";
  const phonesA = new Set([digits(a.phone), digits(a.contactPhone)].filter((p) => p.length === 10));
  if ([digits(b.phone), digits(b.contactPhone)].some((p) => p.length === 10 && phonesA.has(p))) return "Same mobile number as the referring shop.";
  const accounts = await tx
    .select({ shopId: bankAccounts.shopId, enc: bankAccounts.accountNumberEncrypted, ifsc: bankAccounts.ifsc, last4: bankAccounts.accountNumberLast4 })
    .from(bankAccounts)
    .where(and(inArray(bankAccounts.shopId, [a.id, b.id]), eq(bankAccounts.method, "BANK_ACCOUNT")));
  const ofA = accounts.filter((x) => x.shopId === a.id);
  const ofB = accounts.filter((x) => x.shopId === b.id);
  for (const x of ofA) {
    for (const y of ofB) {
      if (!x.enc || !y.enc || x.last4 !== y.last4 || (x.ifsc ?? "").toUpperCase() !== (y.ifsc ?? "").toUpperCase()) continue;
      if (decryptSecret(x.enc) === decryptSecret(y.enc)) return "Same bank account as the referring shop.";
    }
  }
  return null;
}

/**
 * Called when an order becomes DELIVERED (inside that transaction, under a
 * savepoint). Rewards the referral of the order's shop when this is its first
 * delivered order and the shop is approved; otherwise decides it REJECTED with
 * the reason, or leaves it waiting (not yet approved).
 */
export async function rewardShopReferralOnDelivery(orderId: string, tx: DbClient): Promise<void> {
  const rule = await shopReferralRule();
  if (!rule.enabled) return;
  const [order] = await tx.select({ id: orders.id, shopId: orders.shopId, status: orders.status }).from(orders).where(eq(orders.id, orderId));
  if (!order || order.status !== "DELIVERED") return;
  const [referral] = await tx.select().from(shopReferrals).where(and(eq(shopReferrals.referredShopId, order.shopId), eq(shopReferrals.status, "PENDING"))).for("update");
  if (!referral) return;
  const pair = await tx.select().from(shops).where(inArray(shops.id, [referral.referrerShopId, referral.referredShopId]));
  const referrer = pair.find((s) => s.id === referral.referrerShopId);
  const referred = pair.find((s) => s.id === referral.referredShopId);
  if (!referred || referred.status !== "APPROVED") return; // waits for activation

  let rejection: string | null = null;
  if (!referrer || referrer.deletedAt || referrer.status !== "APPROVED") rejection = "The referring shop is no longer live.";
  if (!rejection) rejection = await sameBusiness(tx, referrer!, referred);
  if (!rejection) {
    const match = await findLikelyDuplicate(referred.id, tx);
    if (match.kind === "BRANCH") rejection = "The new shop looks like a branch of an existing shop.";
    if (match.kind === "DUPLICATE") rejection = `The new shop looks like a duplicate of an existing shop (${match.reasons.join(", ")}).`;
  }
  if (!rejection) {
    // One code only: a shop counted for a dealer after all earns the dealer, not the referring shop.
    const [attribution] = await tx.select({ status: shopAttributions.status }).from(shopAttributions).where(eq(shopAttributions.shopId, referred.id));
    if (attribution?.status === "ACTIVE") rejection = "The new shop is counted for a dealer.";
  }
  if (rejection) {
    await tx.update(shopReferrals).set({ status: "REJECTED", rejectionReason: rejection, qualifyingOrderId: orderId, updatedAt: new Date() }).where(eq(shopReferrals.id, referral.id));
    await recordAudit({ action: AUDIT_ACTIONS.SHOP_REFERRAL_DECIDED, entityType: "shop_referral", entityId: referral.id, newValue: { status: "REJECTED", rejection, orderId } }, tx);
    return;
  }

  const since = new Date(Date.now() - 365 * 86_400_000);
  const [{ used }] = await tx
    .select({ used: count() })
    .from(shopReferrals)
    // A reversed reward still uses up one of the year's rewards.
    .where(and(eq(shopReferrals.referrerShopId, referral.referrerShopId), inArray(shopReferrals.status, ["REWARDED", "REVERSED"]), gte(shopReferrals.rewardedAt, since)));
  const referrerEligible = used < rule.maxRewardsPerYear;
  const referrerCredit = referrerEligible && rule.referrerMode === "WALLET_CREDIT" ? rule.referrerCreditPaise : 0;
  const extensionMonths = referrerEligible && rule.referrerMode === "MEMBERSHIP_EXTENSION" ? rule.referrerExtensionMonths : 0;
  const referredCredit = referral.referredMode === "WALLET_CREDIT" ? rule.referredCreditPaise : 0;

  let membershipBefore: Date | null = null;
  let membershipAfter: Date | null = null;
  if (extensionMonths > 0) {
    const [locked] = await tx.select({ until: shops.membershipValidUntil }).from(shops).where(eq(shops.id, referral.referrerShopId)).for("update");
    membershipBefore = locked?.until ?? null;
    // From the current end (or today, when it has passed or there is none).
    const from = membershipBefore && membershipBefore.getTime() > Date.now() ? membershipBefore : new Date();
    membershipAfter = addMonths(from, extensionMonths);
    await tx.update(shops).set({ membershipValidUntil: membershipAfter, updatedAt: new Date() }).where(eq(shops.id, referral.referrerShopId));
  }
  for (const [shopId, amount, who] of [
    [referral.referrerShopId, referrerCredit, "referrer"],
    [referral.referredShopId, referredCredit, "referred"],
  ] as const) {
    if (amount <= 0) continue;
    await applyShopWalletEntry(
      {
        shopId,
        type: "MANUAL_CREDIT",
        amountPaise: amount,
        promotional: true,
        reason: who === "referrer" ? `Shop referral reward — ${referred.name} joined with your code (promotional credit)` : "Welcome credit — joined with a shop's referral code (promotional credit)",
        idempotencyKey: `shop-referral:${referral.id}:${who}`,
      },
      tx,
    );
  }
  const rewarded = referrerCredit > 0 || extensionMonths > 0;
  await tx
    .update(shopReferrals)
    .set({
      status: "REWARDED",
      qualifyingOrderId: orderId,
      referrerRewardKind: rewarded ? rule.referrerMode : null,
      referrerRewardPaise: referrerCredit,
      referrerExtensionMonths: extensionMonths,
      referredRewardPaise: referredCredit,
      membershipBefore,
      membershipAfter,
      rejectionReason: referrerEligible ? null : `The referring shop already had ${rule.maxRewardsPerYear} rewards in 12 months.`,
      rewardedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(shopReferrals.id, referral.id));
  await recordAudit(
    {
      action: AUDIT_ACTIONS.SHOP_REFERRAL_DECIDED,
      entityType: "shop_referral",
      entityId: referral.id,
      newValue: { status: "REWARDED", orderId, referrerCredit, extensionMonths, referredCredit, membershipBefore: membershipBefore?.toISOString() ?? null, membershipAfter: membershipAfter?.toISOString() ?? null, referrerEligible },
    },
    tx,
  );
  const tell = async (shop: Shop, reward: string, detail: string) =>
    notify({ userId: shop.ownerId, type: NOTIFICATION_TYPES.SHOP_REFERRAL_REWARDED, vars: { shopName: referred.name, reward, detail }, actionUrl: "/shop/wallet", channels: ["PUSH"], dedupeKey: `shop-referral:${referral.id}:${shop.id}` }, tx);
  if (referrerCredit > 0) await tell(referrer!, `${formatPaise(referrerCredit)} promotional credit`, "added to your shop wallet; it pays GoKesari commission and delivery charges.");
  if (extensionMonths > 0) await tell(referrer!, `${extensionMonths} month(s) more membership`, `your membership now runs to ${membershipAfter!.toISOString().slice(0, 10)}.`);
  if (referredCredit > 0) await tell(referred, `${formatPaise(referredCredit)} welcome credit`, "added to your shop wallet; it pays GoKesari commission and delivery charges.");
}

/* ============================================================== reversal */

/**
 * ADMIN: takes back a rewarded shop referral found fraudulent (as D-25 for
 * customers). Wallet credit is debited back — never below zero, and only the
 * promotional part still unspent; the rest is recorded as not recovered. A
 * membership extension is taken off again (never before the end it had). A
 * second call returns the reversed row unchanged.
 */
export async function reverseShopReferral(referralId: string, reason: string, actor: Actor): Promise<ShopReferral> {
  if (actor.role !== "ADMIN") throw conflict("Only an admin can reverse a shop referral reward.");
  const note = reason.trim();
  if (note.length < 5) throw validationFailed("Give the reason for reversing this reward.");
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(shopReferrals).where(eq(shopReferrals.id, referralId)).for("update");
    if (!row) throw notFound("Shop referral");
    if (row.status === "REVERSED") return { row, told: [] as { shopId: string; detail: string }[] };
    if (row.status !== "REWARDED") throw conflict("Only a rewarded referral can be reversed.");
    const recovered = { referrer: 0, referred: 0 };
    const told: { shopId: string; detail: string }[] = [];
    for (const [shopId, reward, who] of [
      [row.referrerShopId, row.referrerRewardPaise, "referrer"],
      [row.referredShopId, row.referredRewardPaise, "referred"],
    ] as const) {
      if (reward <= 0) continue;
      const original = await tx.query.shopWalletTransactions.findFirst({ where: eq(shopWalletTransactions.idempotencyKey, `shop-referral:${row.id}:${who}`) });
      if (!original) continue;
      const [wallet] = await tx.select().from(shopWallets).where(eq(shopWallets.shopId, shopId)).for("update");
      const take = Math.min(reward, Math.max(0, Number(wallet?.promoBalancePaise ?? 0)), Math.max(0, Number(wallet?.balancePaise ?? 0)));
      if (take > 0) {
        await applyShopWalletEntry(
          { shopId, type: "MANUAL_DEBIT", amountPaise: take, promotional: true, reason: "Shop referral reward taken back after a review", idempotencyKey: `shop-referral:${row.id}:${who}:reversal`, createdBy: actor.id },
          tx,
        );
      }
      recovered[who] = take;
      told.push({ shopId, detail: take > 0 ? `${formatPaise(take)} was taken back from your shop wallet.` : "The credit had already been spent." });
    }
    if (row.referrerExtensionMonths > 0 && row.membershipAfter) {
      const [shop] = await tx.select({ until: shops.membershipValidUntil }).from(shops).where(eq(shops.id, row.referrerShopId)).for("update");
      if (shop?.until) {
        const back = addMonths(shop.until, -row.referrerExtensionMonths);
        const floor = row.membershipBefore;
        const until = floor && back.getTime() < floor.getTime() ? floor : back;
        await tx.update(shops).set({ membershipValidUntil: until, updatedAt: new Date() }).where(eq(shops.id, row.referrerShopId));
        told.push({ shopId: row.referrerShopId, detail: `The ${row.referrerExtensionMonths} month(s) of membership were taken off again.` });
      }
    }
    const [updated] = await tx
      .update(shopReferrals)
      .set({ status: "REVERSED", reversedAt: new Date(), reversedBy: actor.id, reversalReason: note, referrerRecoveredPaise: recovered.referrer, referredRecoveredPaise: recovered.referred, updatedAt: new Date() })
      .where(eq(shopReferrals.id, row.id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_REFERRAL_REVERSED,
        entityType: "shop_referral",
        entityId: row.id,
        previousValue: { status: row.status, referrerRewardPaise: row.referrerRewardPaise, referredRewardPaise: row.referredRewardPaise, referrerExtensionMonths: row.referrerExtensionMonths },
        newValue: {
          status: "REVERSED",
          reason: note,
          referrerRecoveredPaise: recovered.referrer,
          referredRecoveredPaise: recovered.referred,
          referrerUnrecoveredPaise: row.referrerRewardPaise - recovered.referrer,
          referredUnrecoveredPaise: row.referredRewardPaise - recovered.referred,
        },
      },
      tx,
    );
    return { row: updated, told };
  });
  if (result.told.length) {
    const owners = await db.select({ id: shops.id, ownerId: shops.ownerId }).from(shops).where(inArray(shops.id, [...new Set(result.told.map((t) => t.shopId))]));
    for (const t of result.told) {
      const owner = owners.find((o) => o.id === t.shopId);
      if (owner) await notify({ userId: owner.ownerId, type: NOTIFICATION_TYPES.SHOP_REFERRAL_REVERSED, vars: { detail: t.detail }, actionUrl: "/shop/wallet", channels: ["PUSH"] });
    }
  }
  return result.row;
}

/* ================================================================= views */

export interface ShopReferralSummary {
  enabled: boolean;
  code: string | null;
  pending: number;
  rewarded: number;
  rejected: number;
  earnedPaise: number;
  extensionMonths: number;
}

/** The shop's code and how its referrals went (manage page). */
export async function shopReferralSummary(shopId: string): Promise<ShopReferralSummary> {
  const rule = await shopReferralRule();
  if (!rule.enabled) return { enabled: false, code: null, pending: 0, rewarded: 0, rejected: 0, earnedPaise: 0, extensionMonths: 0 };
  const code = await getOrCreateShopReferralCode(shopId);
  const rows = await db
    .select({
      status: shopReferrals.status,
      n: count(),
      earned: sql<number>`coalesce(sum(${shopReferrals.referrerRewardPaise}), 0)::int`,
      months: sql<number>`coalesce(sum(${shopReferrals.referrerExtensionMonths}), 0)::int`,
    })
    .from(shopReferrals)
    .where(eq(shopReferrals.referrerShopId, shopId))
    .groupBy(shopReferrals.status);
  const by = (s: string) => rows.find((r) => r.status === s);
  return {
    enabled: true,
    code,
    pending: by("PENDING")?.n ?? 0,
    rewarded: by("REWARDED")?.n ?? 0,
    rejected: by("REJECTED")?.n ?? 0,
    earnedPaise: by("REWARDED")?.earned ?? 0,
    extensionMonths: by("REWARDED")?.months ?? 0,
  };
}

/** Admin → Shop referrals: recent referrals with their outcome. */
export async function listShopReferrals(filter: { status?: ShopReferral["status"] } = {}, limit = 300) {
  const rows = await db
    .select()
    .from(shopReferrals)
    .where(filter.status ? eq(shopReferrals.status, filter.status) : sql`true`)
    .orderBy(desc(shopReferrals.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.referrerShopId, r.referredShopId]))];
  const names = new Map((await db.select({ id: shops.id, name: shops.name }).from(shops).where(inArray(shops.id, ids))).map((s) => [s.id, s.name]));
  return rows.map((r) => ({ ...r, referrerName: names.get(r.referrerShopId) ?? "—", referredName: names.get(r.referredShopId) ?? "—" }));
}
