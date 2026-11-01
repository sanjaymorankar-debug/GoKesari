/**
 * Rider withdrawals and the rider's bank account (docs/gig-bank-payouts-2026-10).
 *
 * The bank account is the user's personal one — the same bank_accounts row a
 * customer adds for refunds (one primary account per user, whatever their
 * roles), added and verified through the existing screens and ₹1 check. What
 * is new for delivery partners (flag rider_bank_account_enabled):
 *   - changing or removing a VERIFIED account needs an emailed code first
 *     (a 10-minute, single-use rider_security_grants row);
 *   - withdrawals (flag rider_withdrawal_enabled) of unpaid earnings, each
 *     confirmed with an emailed code, within rule riderPayouts' limits.
 * Customers' wallets are untouched: the owner kept them closed (RBI closed
 * prepaid wallet, /legal/wallet-terms) — 31 Oct 2026.
 */
import { and, eq, gt, gte, isNull, notInArray, sql } from "drizzle-orm";

import { todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { AppError, conflict, forbidden, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { db, type DbClient } from "@/server/db";
import { bankAccounts, deliveryPartners, riderBankTransfers, riderSecurityGrants, users, type DeliveryPartner, type UserRole } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { requestAccountActionOtp, verifyAccountActionOtp } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { currentBankAccount } from "@/server/services/bank-accounts";
import { isFeatureEnabled, requireFeature } from "@/server/services/feature-flags";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { withdrawalProblem } from "./rules";
import { accountLabel, activeRiderProvider, claimIntoTransfer, payableAccount, railFor, sendTransfer } from "./transfers";

interface Actor {
  id: string;
  role: UserRole;
}

const GRANT_MINUTES = 10;

/** The signed-in user's delivery partner row, or null. */
export async function riderOf(userId: string): Promise<DeliveryPartner | null> {
  const [row] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.userId, userId));
  return row ?? null;
}

/**
 * "KYC complete" for payouts: the partner is APPROVED (identity documents
 * checked at approval). One place to tighten when the new rider KYC
 * (PAN / Aadhaar checks, feat/gig-worker-flow) lands.
 */
export function kycComplete(partner: Pick<DeliveryPartner, "status">): boolean {
  return partner.status === "APPROVED";
}

async function accountEmail(userId: string): Promise<string> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  if (!user?.email || isPlaceholderEmail(user.email)) {
    throw conflict("Add your email address in your profile first: the confirmation code is sent there.", { reason: "EMAIL_REQUIRED" });
  }
  return user.email;
}

function codeEmail(action: string) {
  return (code: string, expiryMinutes: number) => ({
    subject: `${code} — confirm ${action} on GoKesari`,
    text: `Use this code to confirm ${action} on GoKesari.\n\nYour code: ${code}\n\nIt works once and expires in ${expiryMinutes} minutes. If this was not you, do not share it and change your sign-in email.\n`,
    html:
      `<p>Use this code to confirm ${action} on GoKesari.</p><p>Your code:</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${code}</p>` +
      `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. If this was not you, do not share it and change your sign-in email.</p>`,
  });
}

/* ====================================================== bank account change */

/**
 * Does this user need to re-authenticate before changing their personal bank
 * account? Only a delivery partner with a VERIFIED account, and only while the
 * flag is on (off: everything behaves as before).
 */
export async function bankChangeNeedsReauth(userId: string): Promise<boolean> {
  if (!(await isFeatureEnabled("rider_bank_account_enabled"))) return false;
  const partner = await riderOf(userId);
  if (!partner) return false;
  const account = await currentBankAccount(userId, null);
  return account?.status === "VERIFIED";
}

export async function requestBankChangeCode(actor: Actor, ip: string | null) {
  await requireFeature("rider_bank_account_enabled");
  return requestAccountActionOtp({ email: await accountEmail(actor.id), userId: actor.id, purpose: "RIDER_BANK_CHANGE", ip, render: codeEmail("a change to your bank account") });
}

/** The code is right: the rider may change or remove the account in the next 10 minutes, once. */
export async function confirmBankChangeCode(actor: Actor, code: string, ip: string | null): Promise<{ expiresAt: string }> {
  await requireFeature("rider_bank_account_enabled");
  await verifyAccountActionOtp({ email: await accountEmail(actor.id), userId: actor.id, purpose: "RIDER_BANK_CHANGE", code, ip });
  const expiresAt = new Date(Date.now() + GRANT_MINUTES * 60_000);
  await db.insert(riderSecurityGrants).values({ userId: actor.id, purpose: "BANK_ACCOUNT_CHANGE", expiresAt });
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.RIDER_BANK_ACCOUNT_REAUTH, entityType: "user", entityId: actor.id, newValue: { expiresAt: expiresAt.toISOString() }, ipAddress: ip });
  return { expiresAt: expiresAt.toISOString() };
}

/**
 * Called before a delivery partner's verified account is replaced or removed:
 * uses up a live grant, or refuses with REAUTH_REQUIRED (the screen then asks
 * for the emailed code). A no-op for anyone else.
 */
export async function consumeBankChangeGrant(userId: string): Promise<void> {
  if (!(await bankChangeNeedsReauth(userId))) return;
  const [used] = await db
    .update(riderSecurityGrants)
    .set({ usedAt: new Date() })
    .where(
      sql`${riderSecurityGrants.id} = (select id from ${riderSecurityGrants} where ${and(
        eq(riderSecurityGrants.userId, userId),
        eq(riderSecurityGrants.purpose, "BANK_ACCOUNT_CHANGE"),
        isNull(riderSecurityGrants.usedAt),
        gt(riderSecurityGrants.expiresAt, new Date()),
      )} order by ${riderSecurityGrants.createdAt} desc limit 1 for update skip locked)`,
    )
    .returning({ id: riderSecurityGrants.id });
  if (!used) {
    throw new AppError("FORBIDDEN", "Confirm it's you first: we'll email you a code before your bank account can be changed.", { reason: "REAUTH_REQUIRED" });
  }
}

/** Removes the personal bank account (it stops being current; history stays). Not while money is on its way to it. */
export async function removeBankAccount(actor: Actor): Promise<void> {
  await requireFeature("rider_bank_account_enabled");
  const account = await currentBankAccount(actor.id, null);
  if (!account) return;
  const [inFlight] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(riderBankTransfers)
    .where(and(eq(riderBankTransfers.userId, actor.id), notInArray(riderBankTransfers.status, ["SUCCESS", "REVERSED", "RELEASED"])));
  if (inFlight.n > 0) throw conflict("A payment to this account is still on its way. Remove it once it has arrived (or was returned).");
  await consumeBankChangeGrant(actor.id);
  await db.update(bankAccounts).set({ isCurrent: false, supersededAt: new Date(), updatedAt: new Date() }).where(eq(bankAccounts.id, account.id));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_BANK_ACCOUNT_REMOVED,
    entityType: "bank_account",
    entityId: account.id,
    previousValue: { account: accountLabel(account), status: account.status },
  });
}

/* ============================================================ withdrawals */

async function withdrawalGate(actor: Actor): Promise<DeliveryPartner> {
  await requireFeature("rider_bank_account_enabled");
  await requireFeature("rider_withdrawal_enabled");
  const partner = await riderOf(actor.id);
  if (!partner) throw forbidden("Only delivery partners can withdraw earnings.");
  if (!kycComplete(partner)) throw conflict("Withdrawals open once your delivery partner application is approved.", { reason: "KYC_INCOMPLETE" });
  return partner;
}

export async function requestWithdrawalCode(actor: Actor, amountPaise: number, ip: string | null) {
  await withdrawalGate(actor);
  return requestAccountActionOtp({
    email: await accountEmail(actor.id),
    userId: actor.id,
    purpose: "RIDER_WITHDRAWAL",
    ip,
    render: codeEmail(`a withdrawal of ${formatPaise(amountPaise)} to your bank account`),
  });
}

export async function withdrawnTodayPaise(deliveryPartnerId: string, client: DbClient = db): Promise<number> {
  const today = todayIn(getEnv().APP_TIMEZONE);
  const [row] = await client
    .select({ sum: sql<string>`coalesce(sum(${riderBankTransfers.grossPaise}), 0)` })
    .from(riderBankTransfers)
    .where(
      and(
        eq(riderBankTransfers.deliveryPartnerId, deliveryPartnerId),
        eq(riderBankTransfers.kind, "WITHDRAWAL"),
        notInArray(riderBankTransfers.status, ["RELEASED"]),
        gte(riderBankTransfers.createdAt, new Date(`${today}T00:00:00+05:30`)),
      ),
    );
  return Number(row.sum);
}

/**
 * Withdraws `amountPaise` of the rider's unpaid earnings to their verified
 * account. The emailed code is checked first; the claim commits before the
 * bank is called (so the same earnings cannot be withdrawn twice), and a
 * refused transfer hands the amount straight back.
 */
export async function withdraw(actor: Actor, input: { amountPaise: number; code: string }, ip: string | null) {
  const partner = await withdrawalGate(actor);
  const rule = await getRule("riderPayouts");
  const account = await payableAccount(actor.id);
  if (!account) throw conflict("Add and verify your bank account first.", { reason: "BANK_NOT_VERIFIED" });
  const provider = await activeRiderProvider();
  if (!provider) throw conflict("Withdrawals are not available right now. Please try again later.", { reason: "PROVIDER_UNAVAILABLE" });
  if (!Number.isInteger(input.amountPaise)) throw validationFailed("Enter the amount in rupees and paise.", { fields: { amount: "Invalid amount" } });

  await verifyAccountActionOtp({ email: await accountEmail(actor.id), userId: actor.id, purpose: "RIDER_WITHDRAWAL", code: input.code, ip });

  const today = todayIn(getEnv().APP_TIMEZONE);
  const claimed = await db.transaction(async (tx) => {
    // One withdrawal at a time per rider: the limits below are read under this lock.
    await tx.select({ id: deliveryPartners.id }).from(deliveryPartners).where(eq(deliveryPartners.id, partner.id)).for("update");
    const withdrawnToday = await withdrawnTodayPaise(partner.id, tx);
    return claimIntoTransfer(tx, {
      deliveryPartnerId: partner.id,
      userId: actor.id,
      kind: "WITHDRAWAL",
      before: null,
      amountPaise: input.amountPaise,
      check: (availablePaise) => {
        const problem = withdrawalProblem(rule, { amountPaise: input.amountPaise, availablePaise, withdrawnTodayPaise: withdrawnToday });
        if (problem) throw validationFailed(problem, { fields: { amount: problem } });
      },
      feePaise: rule.withdrawalFeePaise,
      account,
      provider,
      mode: railFor(account, rule.withdrawalMode),
      runId: null,
      periodStart: today,
      periodEnd: today,
      actor,
    });
  });
  if (!claimed) throw validationFailed("There is nothing to withdraw yet.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_WITHDRAWAL_REQUESTED,
    entityType: "rider_bank_transfer",
    entityId: claimed.transfer.id,
    newValue: { amountPaise: claimed.transfer.grossPaise, tdsPaise: claimed.transfer.tdsPaise, feePaise: claimed.transfer.feePaise, account: accountLabel(account) },
    ipAddress: ip,
  });
  await notify({
    userId: actor.id,
    type: NOTIFICATION_TYPES.RIDER_WITHDRAWAL_SENT,
    vars: {
      amount: formatPaise(claimed.transfer.netPaise),
      account: accountLabel(account),
      tdsNote: claimed.transfer.tdsPaise > 0 ? ` (after TDS of ${formatPaise(claimed.transfer.tdsPaise)})` : "",
      settlement: rule.withdrawalSettlement,
    },
    dedupeKey: `rider-transfer:${claimed.transfer.id}:sent`,
    actionUrl: `/gig/wallet/payouts/${claimed.transfer.id}`,
  });
  return sendTransfer(claimed.transfer.id, actor);
}
