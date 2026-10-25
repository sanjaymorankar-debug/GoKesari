/**
 * Customer referral rewards (feature F11).
 *
 * Every customer has a code (and a link, /r/CODE). A new customer applies a
 * friend's code before their first order; when their first order is
 * delivered, both are credited the configured reward as promotional wallet
 * credit (rule "customerReferrals"). Guards:
 *   - self-referral: never your own code (also a database check);
 *   - one referrer per customer; only new customers (within N days of
 *     joining, no orders yet), and only someone who joined after the referrer;
 *   - duplicate accounts: no reward when the friend has the referrer's mobile
 *     number, when their order went to one of the referrer's own addresses,
 *     or when that mobile number has already earned a referral reward;
 *   - a referrer earns at most `maxRewardsPerReferrer` rewards.
 * Rewards are idempotent (wallet idempotency keys) and are decided once.
 * A reward later found fraudulent can be reversed by an admin (D-25):
 * reverseCustomerReferral takes it back from both wallets.
 */
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  customerReferralCodes,
  customerReferrals,
  orders,
  users,
  walletTransactions,
  wallets,
  type CustomerReferral,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getRule } from "./settings";
import { applyWalletMutation, getOrCreateWallet } from "./wallet";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const randomCode = () => "GK" + Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
export const normalizeReferralCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The customer's own code, created on first use. */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await db.query.customerReferralCodes.findFirst({ where: eq(customerReferralCodes.userId, userId) });
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await db.insert(customerReferralCodes).values({ userId, code: randomCode() }).onConflictDoNothing().returning();
    if (row) return row.code;
    const mine = await db.query.customerReferralCodes.findFirst({ where: eq(customerReferralCodes.userId, userId) });
    if (mine) return mine.code;
  }
  throw new Error("Could not allocate a referral code.");
}

const normalizeLine = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Why this customer can't apply a code now, or null when they can. */
async function ineligibility(userId: string, applyWithinDays: number): Promise<string | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return "Account not found.";
  if (Date.now() - user.createdAt.getTime() > applyWithinDays * 86_400_000) {
    return `Referral codes can only be used within ${applyWithinDays} days of joining.`;
  }
  const [{ n }] = await db.select({ n: count() }).from(orders).where(eq(orders.userId, userId));
  if (n > 0) return "Referral codes can only be used before your first order.";
  const already = await db.query.customerReferrals.findFirst({ where: eq(customerReferrals.refereeUserId, userId) });
  if (already) return "You have already used a referral code.";
  return null;
}

/**
 * Refuses a customer's own code (or a code of an account on their mobile), and
 * leaves an audit row: risk rule REFERRAL_ABUSE counts repeated tries
 * (TC-MKT-015).
 */
async function refuseOwnCode(userId: string, code: string, reason: "OWN_CODE" | "SAME_MOBILE"): Promise<never> {
  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.CUSTOMER_REFERRAL_REFUSED,
    entityType: "customer_referral",
    newValue: { code, reason },
  });
  throw validationFailed("You can't use your own referral code.");
}

/** Applies a friend's code to the signed-in (new) customer. */
export async function applyReferralCode(userId: string, rawCode: string): Promise<CustomerReferral> {
  const rule = await getRule("customerReferrals");
  if (!rule.enabled) throw validationFailed("Referral codes aren't available right now.");
  const code = normalizeReferralCode(rawCode);
  const owner = code ? await db.query.customerReferralCodes.findFirst({ where: eq(customerReferralCodes.code, code) }) : null;
  if (!owner) throw validationFailed("That referral code isn't valid.");
  if (owner.userId === userId) await refuseOwnCode(userId, code, "OWN_CODE");
  const why = await ineligibility(userId, rule.applyWithinDays);
  if (why) throw conflict(why);

  const people = await db.select().from(users).where(inArray(users.id, [userId, owner.userId]));
  const me = people.find((u) => u.id === userId)!;
  const referrer = people.find((u) => u.id === owner.userId);
  if (!referrer || referrer.deletedAt) throw validationFailed("That referral code isn't valid.");
  if (referrer.createdAt >= me.createdAt) throw validationFailed("That referral code isn't valid for your account.");
  if (me.phoneE164 && referrer.phoneE164 && me.phoneE164 === referrer.phoneE164) {
    await refuseOwnCode(userId, code, "SAME_MOBILE");
  }

  const [row] = await db
    .insert(customerReferrals)
    .values({ referrerUserId: owner.userId, refereeUserId: userId, code })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict("You have already used a referral code.");
  await recordAudit({
    actorId: userId,
    action: AUDIT_ACTIONS.CUSTOMER_REFERRAL_APPLIED,
    entityType: "customer_referral",
    entityId: row.id,
    newValue: { referrerUserId: owner.userId, code },
  });
  return row;
}

/** Whether the signed-in customer can still apply a code (for showing the box). */
export async function canApplyReferralCode(userId: string): Promise<boolean> {
  const rule = await getRule("customerReferrals");
  return rule.enabled && (await ineligibility(userId, rule.applyWithinDays)) == null;
}

export async function getReferralSummary(userId: string) {
  const code = await getOrCreateReferralCode(userId);
  const rows = await db
    .select({
      status: customerReferrals.status,
      n: count(),
      earned: sql<number>`coalesce(sum(${customerReferrals.referrerRewardPaise}), 0)::bigint`,
    })
    .from(customerReferrals)
    .where(eq(customerReferrals.referrerUserId, userId))
    .groupBy(customerReferrals.status);
  const by = (s: string) => rows.find((r) => r.status === s);
  const mine = await db.query.customerReferrals.findFirst({ where: eq(customerReferrals.refereeUserId, userId) });
  return {
    code,
    pending: by("PENDING")?.n ?? 0,
    rewarded: by("REWARDED")?.n ?? 0,
    earnedPaise: Number(by("REWARDED")?.earned ?? 0),
    referredBy: mine ? { status: mine.status, rewardPaise: mine.refereeRewardPaise } : null,
  };
}

/**
 * Called when an order becomes DELIVERED (inside that transaction, under a
 * savepoint). Rewards the customer's pending referral if this is their first
 * delivered order and no duplicate-account signal is found.
 */
export async function rewardReferralOnDelivery(orderId: string, tx: DbClient): Promise<void> {
  const rule = await getRule("customerReferrals");
  if (!rule.enabled) return;
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order || order.status !== "DELIVERED") return;
  const [referral] = await tx
    .select()
    .from(customerReferrals)
    .where(and(eq(customerReferrals.refereeUserId, order.userId), eq(customerReferrals.status, "PENDING")))
    .for("update");
  if (!referral) return;
  const [{ delivered }] = await tx
    .select({ delivered: count() })
    .from(orders)
    .where(and(eq(orders.userId, order.userId), eq(orders.status, "DELIVERED"), ne(orders.id, orderId)));
  if (delivered > 0) return; // not the first delivered order (a later one can't qualify either)

  const people = await tx.select().from(users).where(inArray(users.id, [referral.referrerUserId, referral.refereeUserId]));
  const referrer = people.find((u) => u.id === referral.referrerUserId);
  const referee = people.find((u) => u.id === referral.refereeUserId);
  const phone = referee?.phoneE164 ?? null;

  let rejection: string | null = null;
  if (!referrer || referrer.deletedAt) rejection = "The referrer's account is closed.";
  else if (phone && referrer.phoneE164 === phone) rejection = "Same mobile number as the referrer.";
  else if (phone) {
    const reused = await tx
      .select({ id: customerReferrals.id })
      .from(customerReferrals)
      .where(and(eq(customerReferrals.refereePhoneE164, phone), inArray(customerReferrals.status, ["REWARDED", "REVERSED"])));
    if (reused.length > 0) rejection = "This mobile number has already earned a referral reward.";
  }
  if (!rejection && order.deliveryAddressSnapshot) {
    const snap = order.deliveryAddressSnapshot;
    const referrerAddresses = await tx
      .select({ line1: addresses.line1, pincode: addresses.pincode })
      .from(addresses)
      .where(and(eq(addresses.userId, referral.referrerUserId), isNull(addresses.deletedAt)));
    if (referrerAddresses.some((a) => a.pincode === snap.pincode && normalizeLine(a.line1) === normalizeLine(snap.line1))) {
      rejection = "Delivered to the referrer's own address.";
    }
  }

  if (rejection) {
    await tx
      .update(customerReferrals)
      .set({ status: "REJECTED", rejectionReason: rejection, qualifyingOrderId: orderId })
      .where(eq(customerReferrals.id, referral.id));
    await recordAudit(
      { action: AUDIT_ACTIONS.CUSTOMER_REFERRAL_DECIDED, entityType: "customer_referral", entityId: referral.id, newValue: { status: "REJECTED", rejection, orderId } },
      tx,
    );
    return;
  }

  const [{ earnedCount }] = await tx
    .select({ earnedCount: count() })
    .from(customerReferrals)
    .where(
      and(
        eq(customerReferrals.referrerUserId, referral.referrerUserId),
        // A reversed reward still uses up one of the referrer's rewards.
        inArray(customerReferrals.status, ["REWARDED", "REVERSED"]),
        sql`coalesce(${customerReferrals.referrerRewardPaise}, 0) > 0`,
      ),
    );
  const referrerReward = earnedCount < rule.maxRewardsPerReferrer ? rule.referrerRewardPaise : 0;
  const refereeReward = rule.refereeRewardPaise;

  await tx
    .update(customerReferrals)
    .set({
      status: "REWARDED",
      qualifyingOrderId: orderId,
      referrerRewardPaise: referrerReward,
      refereeRewardPaise: refereeReward,
      refereePhoneE164: phone,
      rewardedAt: new Date(),
    })
    .where(eq(customerReferrals.id, referral.id));

  for (const [userId, amount, who] of [
    [referral.referrerUserId, referrerReward, "referrer"],
    [referral.refereeUserId, refereeReward, "referee"],
  ] as const) {
    if (amount <= 0) continue;
    await getOrCreateWallet(userId, tx);
    await applyWalletMutation(
      {
        userId,
        amountPaise: amount,
        type: "PROMOTIONAL_CREDIT",
        idempotencyKey: `referral:${referral.id}:${who}`,
        description: who === "referrer" ? "Referral reward — your friend's first order was delivered" : "Welcome reward — referred by a friend",
      },
      tx,
    );
    await notify(
      {
        userId,
        type: NOTIFICATION_TYPES.REFERRAL_REWARDED,
        title: "Referral reward",
        body: `${formatPaise(amount)} has been added to your wallet as a referral reward.`,
        actionUrl: "/wallet",
      },
      tx,
    );
  }
  await recordAudit(
    {
      action: AUDIT_ACTIONS.CUSTOMER_REFERRAL_DECIDED,
      entityType: "customer_referral",
      entityId: referral.id,
      newValue: { status: "REWARDED", orderId, referrerReward, refereeReward },
    },
    tx,
  );
}

/**
 * D-25: takes back a rewarded referral found fraudulent. Each reward is
 * debited from its wallet as a REVERSAL pointing at the original credit. A
 * wallet never goes below zero: when the credit was already spent, the
 * balance is taken and the rest recorded as not recovered. The friend's
 * mobile stays used, so it can't earn a reward again. Repeating the call
 * returns the reversed referral unchanged.
 */
export async function reverseCustomerReferral(
  referralId: string,
  reason: string,
  actor: { id: string; role: UserRole },
): Promise<CustomerReferral> {
  const note = reason.trim();
  if (note.length < 5) throw validationFailed("Give the reason for reversing this reward.");
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(customerReferrals).where(eq(customerReferrals.id, referralId)).for("update");
    if (!row) throw notFound("Customer referral");
    if (row.status === "REVERSED") return row;
    if (row.status !== "REWARDED") throw conflict("Only a rewarded referral can be reversed.");

    const recovered: Record<"referrer" | "referee", number> = { referrer: 0, referee: 0 };
    const credited: { userId: string; recovered: number }[] = [];
    for (const [userId, reward, who] of [
      [row.referrerUserId, row.referrerRewardPaise ?? 0, "referrer"],
      [row.refereeUserId, row.refereeRewardPaise ?? 0, "referee"],
    ] as const) {
      if (reward <= 0) continue;
      const original = await tx.query.walletTransactions.findFirst({ where: eq(walletTransactions.idempotencyKey, `referral:${row.id}:${who}`) });
      if (!original) continue; // never paid
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
      const take = Math.min(reward, Math.max(0, wallet?.balancePaise ?? 0));
      if (take > 0) {
        await applyWalletMutation(
          {
            userId,
            amountPaise: take,
            type: "REVERSAL",
            idempotencyKey: `referral:${row.id}:${who}:reversal`,
            reversalOfId: original.id,
            createdBy: actor.id,
            description: "Referral reward taken back after a review",
          },
          tx,
        );
      }
      recovered[who] = take;
      credited.push({ userId, recovered: take });
    }

    const [updated] = await tx
      .update(customerReferrals)
      .set({
        status: "REVERSED",
        reversedAt: new Date(),
        reversedBy: actor.id,
        reversalReason: note,
        referrerRecoveredPaise: recovered.referrer,
        refereeRecoveredPaise: recovered.referee,
      })
      .where(eq(customerReferrals.id, row.id))
      .returning();
    for (const c of credited) {
      await notify(
        {
          userId: c.userId,
          type: NOTIFICATION_TYPES.REFERRAL_REVERSED,
          title: "Referral reward reversed",
          body:
            c.recovered > 0
              ? `A referral reward was reversed after a review; ${formatPaise(c.recovered)} was taken back from your wallet.`
              : "A referral reward was reversed after a review.",
          actionUrl: "/wallet",
        },
        tx,
      );
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.CUSTOMER_REFERRAL_REVERSED,
        entityType: "customer_referral",
        entityId: row.id,
        previousValue: { status: row.status, referrerRewardPaise: row.referrerRewardPaise, refereeRewardPaise: row.refereeRewardPaise },
        newValue: {
          status: "REVERSED",
          reason: note,
          referrerRecoveredPaise: recovered.referrer,
          refereeRecoveredPaise: recovered.referee,
          referrerUnrecoveredPaise: (row.referrerRewardPaise ?? 0) - recovered.referrer,
          refereeUnrecoveredPaise: (row.refereeRewardPaise ?? 0) - recovered.referee,
        },
      },
      tx,
    );
    return updated;
  });
}

/** Admin view: recent referrals with their outcome. */
export async function listCustomerReferrals(limit = 200) {
  const rows = await db.select().from(customerReferrals).orderBy(sql`${customerReferrals.createdAt} desc`).limit(limit);
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.referrerUserId, r.refereeUserId]))];
  const people = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids));
  const label = (id: string) => {
    const p = people.find((u) => u.id === id);
    return p?.name || p?.email || "—";
  };
  return rows.map((r) => ({ ...r, referrerName: label(r.referrerUserId), refereeName: label(r.refereeUserId) }));
}

export async function findReferralCodeOwner(code: string) {
  const row = await db.query.customerReferralCodes.findFirst({ where: eq(customerReferralCodes.code, normalizeReferralCode(code)) });
  if (!row) throw notFound("Referral code");
  return row;
}
