/**
 * Module 7 — self-service account deletion (docs/account-deletion-2026-11,
 * owner brief 23-Nov-2026). Behind feature flag `account_self_deletion_enabled`
 * (seeded OFF): with it off every entry point answers 404.
 *
 * The person deletes their own account from My Profile:
 *  1. `deletionPrecheck` lists what stands in the way (open orders, money in
 *     the wallet, a live shop, rider dues, open returns or disputes …). Live
 *     subscriptions do not block: they are cancelled with the account.
 *  2. `requestAccountDeletionCode` emails a code (OTP purpose ACCOUNT_DELETE)
 *     to the account's own address, under the normal OTP limits.
 *  3. `deleteAccount` checks the code, the typed word DELETE and the reason
 *     (required), cancels the subscriptions, then in one transaction re-runs
 *     the checks on the locked account row and HIDES the account (0199, owner
 *     23-Nov-2026): users.status PENDING_DELETION, a rider profile deactivated,
 *     push tokens removed, the request COOLING_OFF with `purgeAfter` = now +
 *     rule accountDeletion.coolingOffDays (90).
 *  4. During the cooling-off period the person may sign in with an emailed code
 *     and restore the account (`restoreAccount`), or an admin may cancel the
 *     request with a note (`adminCancelDeletion`). Either way the account is
 *     ACTIVE again and the request CANCELLED.
 *  5. The daily job `runDueAccountPurges` re-checks each due account: still
 *     clear → anonymised (`anonymiseInTx`) and COMPLETED, completion email after
 *     commit; a blocker appeared → BLOCKED, ops alerted, nothing purged (it is
 *     retried daily until it clears or is cancelled).
 *
 * Anonymised: the user row (name, email → deleted+<id>@deleted.invalid, phone,
 * photo, status DELETED, deletedAt), saved addresses, push tokens and the
 * customer's own saved bank / UPI accounts (deleted, or retired when a refund
 * record points at them). Consents are kept as history.
 *
 * Kept for legal retention (GST, Income-tax, payment and consumer law; rule
 * accountDeletion.retentionYears): orders and their address snapshots,
 * invoices, payments and payment intents, wallet and wallet transactions,
 * refunds and bank refund requests, ledgers, TDS/TCS records, returns,
 * disputes, rider earnings / payouts / KYC, shop records, audit logs and the
 * consent trail. See the README.
 *
 * Sessions: auth is stateless JWT re-read against the user row on every
 * request; a PENDING_DELETION or DELETED row ends every session the person has,
 * on every device (auth-sessions.ts readSession drops it). A hidden account
 * never gets a session again: the sign-in page shows the restore screen
 * instead (a short-lived signed cookie, `createRestoreTicket`).
 *
 * External side effects (emails, setting a rider offline) run after the
 * transaction commits.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, count, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";

import { maskEmailAddress } from "@/lib/contact";
import { getEnv } from "@/lib/env";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  accountDeletionRequests,
  addresses,
  bankAccounts,
  bankRefundRequests,
  deliveryOrders,
  deliveryPartnerEarnings,
  deliveryPartners,
  orderDisputes,
  orders,
  pushTokens,
  returnRequests,
  riderBankTransfers,
  riderPayouts,
  shops,
  shopStaff,
  subscriptions,
  users,
  wallets,
  type AccountDeletionRequest,
  type UserRole,
} from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { requestAccountActionOtp, verifyAccountActionOtp } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { featureNotAvailable, isFeatureEnabled } from "./feature-flags";
import { getRule } from "./settings";
import { OPEN_ORDER_STATUSES } from "./inventory-alerts";

export const ACCOUNT_DELETION_FLAG = "account_self_deletion_enabled" as const;

/** The word the person types to confirm. */
export const DELETE_CONFIRM_TEXT = "DELETE";

/** Roles that may delete their own account; staff, dealer and society accounts are closed by an administrator. */
export const SELF_DELETABLE_ROLES: readonly UserRole[] = ["CUSTOMER", "SHOP_OWNER", "DELIVERY_PARTNER"];

/** Orders the customer is still waiting on (goods or money). PENDING (unpaid, expires) does not block. */
export const CUSTOMER_OPEN_ORDER_STATUSES = [...OPEN_ORDER_STATUSES, "REFUND_PENDING", "DISPUTED"] as const;
const CLOSED_RETURN_STATUSES = ["REJECTED", "REFUND_COMPLETED", "RETURN_CANCELLED"] as const;
const CLOSED_DISPUTE_STATUSES = ["RESOLVED", "REJECTED", "WITHDRAWN"] as const;
const OPEN_BANK_REFUND_STATUSES = ["REQUESTED", "PROCESSING"] as const;
const LIVE_DELIVERY_JOB_STATUSES = ["ACCEPTED", "PICKED_UP"] as const;
/** A payout not yet paid out (FAILED is still owed to the rider). */
const OPEN_PAYOUT_STATUSES = ["PENDING", "ELIGIBLE", "PROCESSING", "FAILED"] as const;
const FINAL_SUBSCRIPTION_STATUSES = ["CANCELLED", "COMPLETED"] as const;

export type DeletionBlockerCode =
  | "ROLE_NOT_SELF_SERVICE"
  | "NO_EMAIL"
  | "OPEN_ORDERS"
  | "WALLET_BALANCE"
  | "BANK_REFUND_IN_PROGRESS"
  | "OPEN_RETURNS"
  | "OPEN_DISPUTES"
  | "ACTIVE_SHOP"
  | "SHOP_STAFF"
  | "RIDER_LIVE_JOBS"
  | "RIDER_UNSETTLED_DUES";

export interface DeletionBlocker {
  code: DeletionBlockerCode;
  message: string;
  count?: number;
  /** Where the person sorts it out. */
  href?: string;
}

/** Everything the checks need, gathered from the database (or written by hand in tests). */
export interface DeletionFacts {
  role: UserRole;
  email: string;
  emailPlaceholder: boolean;
  openOrders: number;
  walletBalancePaise: number;
  walletPromotionalPaise: number;
  openBankRefunds: number;
  openReturns: number;
  openDisputes: number;
  activeShops: number;
  staffMemberships: number;
  rider: { liveJobs: number; unbatchedEarningsPaise: number; openPayouts: number } | null;
  liveSubscriptions: number;
}

export interface DeletionPrecheck {
  canDelete: boolean;
  blockers: DeletionBlocker[];
  /** Live subscriptions that will be cancelled with the account. */
  subscriptionsToCancel: number;
  /** Promotional (voucher / cashback) credit that cannot be withdrawn and lapses with the account. */
  promotionalForfeitPaise: number;
  /** Where the code goes, masked. Null when the account has no real email. */
  maskedEmail: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Pure: the blockers for a set of facts. Order is the order the person should sort them out. */
export function blockersFrom(facts: DeletionFacts): DeletionBlocker[] {
  const out: DeletionBlocker[] = [];
  if (!SELF_DELETABLE_ROLES.includes(facts.role)) {
    out.push({
      code: "ROLE_NOT_SELF_SERVICE",
      message: "Staff, dealer and society admin accounts are closed by a GoKesari administrator. Contact support.",
      href: "/support",
    });
  }
  if (facts.emailPlaceholder || isPlaceholderEmail(facts.email)) {
    out.push({
      code: "NO_EMAIL",
      message: "Add an email address to your account first — the confirmation code is sent there.",
      href: "/profile",
    });
  }
  if (facts.openOrders > 0) {
    out.push({
      code: "OPEN_ORDERS",
      count: facts.openOrders,
      message: `You have ${plural(facts.openOrders, "order")} not yet delivered or refunded. Wait until ${facts.openOrders === 1 ? "it is" : "they are"} delivered, or cancel ${facts.openOrders === 1 ? "it" : "them"}.`,
      href: "/orders",
    });
  }
  const withdrawable = Math.max(0, facts.walletBalancePaise - facts.walletPromotionalPaise);
  if (withdrawable > 0) {
    out.push({
      code: "WALLET_BALANCE",
      message: `Your wallet holds ${formatPaise(withdrawable)} of your own money. Spend it, or ask for it to be refunded to your bank account from the wallet page, before deleting the account.`,
      href: "/wallet",
    });
  }
  if (facts.openBankRefunds > 0) {
    out.push({
      code: "BANK_REFUND_IN_PROGRESS",
      count: facts.openBankRefunds,
      message: `${plural(facts.openBankRefunds, "refund")} to your bank ${facts.openBankRefunds === 1 ? "is" : "are"} still being paid. Wait until ${facts.openBankRefunds === 1 ? "it has" : "they have"} reached your account.`,
      href: "/wallet",
    });
  }
  if (facts.openReturns > 0) {
    out.push({
      code: "OPEN_RETURNS",
      count: facts.openReturns,
      message: `You have ${plural(facts.openReturns, "return")} still open. Wait until ${facts.openReturns === 1 ? "it is" : "they are"} finished or cancel ${facts.openReturns === 1 ? "it" : "them"}.`,
      href: "/returns",
    });
  }
  if (facts.openDisputes > 0) {
    out.push({
      code: "OPEN_DISPUTES",
      count: facts.openDisputes,
      message: `You have ${plural(facts.openDisputes, "dispute")} still open. Wait until ${facts.openDisputes === 1 ? "it is" : "they are"} resolved, or withdraw ${facts.openDisputes === 1 ? "it" : "them"}.`,
      href: "/orders",
    });
  }
  if (facts.activeShops > 0) {
    out.push({
      code: "ACTIVE_SHOP",
      count: facts.activeShops,
      message: `You own ${plural(facts.activeShops, "shop")} that ${facts.activeShops === 1 ? "is" : "are"} not closed. Close ${facts.activeShops === 1 ? "it" : "them"} permanently first (Shop → Manage → Hours & status).`,
      href: "/shop/manage/hours",
    });
  }
  if (facts.staffMemberships > 0) {
    out.push({
      code: "SHOP_STAFF",
      count: facts.staffMemberships,
      message: `You work at ${plural(facts.staffMemberships, "shop")} as staff. Ask the shop owner to remove you first.`,
    });
  }
  if (facts.rider) {
    if (facts.rider.liveJobs > 0) {
      out.push({
        code: "RIDER_LIVE_JOBS",
        count: facts.rider.liveJobs,
        message: `You have ${plural(facts.rider.liveJobs, "delivery", "deliveries")} in progress. Finish ${facts.rider.liveJobs === 1 ? "it" : "them"} first.`,
        href: "/delivery-partner",
      });
    }
    if (facts.rider.unbatchedEarningsPaise > 0 || facts.rider.openPayouts > 0) {
      out.push({
        code: "RIDER_UNSETTLED_DUES",
        message:
          facts.rider.unbatchedEarningsPaise > 0
            ? `${formatPaise(facts.rider.unbatchedEarningsPaise)} of delivery earnings is still to be paid to you. Wait for the next payout (or withdraw it) before deleting the account.`
            : `${plural(facts.rider.openPayouts, "payout")} to you ${facts.rider.openPayouts === 1 ? "is" : "are"} not yet complete. Wait until ${facts.rider.openPayouts === 1 ? "it reaches" : "they reach"} your bank.`,
        href: "/gig/wallet",
      });
    }
  }
  return out;
}

/** Reads the facts for one user. `client` is the transaction when re-checking before the delete. */
export async function gatherDeletionFacts(userId: string, client: DbClient = db): Promise<DeletionFacts> {
  const [user] = await client
    .select({ role: users.role, email: users.email, emailPlaceholder: users.emailPlaceholder })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) throw forbidden();

  const num = (v: unknown) => Number(v ?? 0);
  const [[ordersRow], [walletRow], [bankRefundRow], [returnsRow], [disputesRow], [shopsRow], [staffRow], [subsRow], [partner]] =
    await Promise.all([
      client
        .select({ n: count() })
        .from(orders)
        .where(and(eq(orders.userId, userId), inArray(orders.status, [...CUSTOMER_OPEN_ORDER_STATUSES]))),
      client
        .select({ balance: wallets.balancePaise, promotional: wallets.promotionalBalancePaise })
        .from(wallets)
        .where(eq(wallets.userId, userId)),
      client
        .select({ n: count() })
        .from(bankRefundRequests)
        .where(and(eq(bankRefundRequests.userId, userId), inArray(bankRefundRequests.status, [...OPEN_BANK_REFUND_STATUSES]))),
      client
        .select({ n: count() })
        .from(returnRequests)
        .where(and(eq(returnRequests.userId, userId), notInArray(returnRequests.status, [...CLOSED_RETURN_STATUSES]))),
      client
        .select({ n: count() })
        .from(orderDisputes)
        .where(
          and(
            notInArray(orderDisputes.status, [...CLOSED_DISPUTE_STATUSES]),
            or(
              eq(orderDisputes.raisedByUserId, userId),
              sql`${orderDisputes.orderId} IN (SELECT ${orders.id} FROM ${orders} WHERE ${orders.userId} = ${userId})`,
            ),
          ),
        ),
      client
        .select({ n: count() })
        .from(shops)
        .where(and(eq(shops.ownerId, userId), isNull(shops.deletedAt), notInArray(shops.status, ["INACTIVE", "REJECTED"]))),
      client
        .select({ n: count() })
        .from(shopStaff)
        .where(and(eq(shopStaff.userId, userId), eq(shopStaff.status, "ACTIVE"))),
      client
        .select({ n: count() })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), notInArray(subscriptions.status, [...FINAL_SUBSCRIPTION_STATUSES]))),
      client
        .select({ id: deliveryPartners.id })
        .from(deliveryPartners)
        .where(and(eq(deliveryPartners.userId, userId), isNull(deliveryPartners.deletedAt))),
    ]);

  let rider: DeletionFacts["rider"] = null;
  if (partner) {
    const [[jobs], [earnings], [payouts]] = await Promise.all([
      client
        .select({ n: count() })
        .from(deliveryOrders)
        .where(and(eq(deliveryOrders.deliveryPartnerId, partner.id), inArray(deliveryOrders.status, [...LIVE_DELIVERY_JOB_STATUSES]))),
      client
        .select({ total: sql<string>`coalesce(sum(${deliveryPartnerEarnings.totalPaise}), 0)` })
        .from(deliveryPartnerEarnings)
        .where(and(eq(deliveryPartnerEarnings.deliveryPartnerId, partner.id), isNull(deliveryPartnerEarnings.payoutId))),
      client
        .select({ n: count() })
        .from(riderPayouts)
        .where(and(eq(riderPayouts.deliveryPartnerId, partner.id), inArray(riderPayouts.status, [...OPEN_PAYOUT_STATUSES]))),
    ]);
    rider = { liveJobs: num(jobs?.n), unbatchedEarningsPaise: num(earnings?.total), openPayouts: num(payouts?.n) };
  }

  return {
    role: user.role,
    email: user.email,
    emailPlaceholder: user.emailPlaceholder,
    openOrders: num(ordersRow?.n),
    walletBalancePaise: num(walletRow?.balance),
    walletPromotionalPaise: num(walletRow?.promotional),
    openBankRefunds: num(bankRefundRow?.n),
    openReturns: num(returnsRow?.n),
    openDisputes: num(disputesRow?.n),
    activeShops: num(shopsRow?.n),
    staffMemberships: num(staffRow?.n),
    rider,
    liveSubscriptions: num(subsRow?.n),
  };
}

/** Pure: the precheck answer for a set of facts. */
export function precheckFrom(facts: DeletionFacts): DeletionPrecheck {
  const blockers = blockersFrom(facts);
  const realEmail = !(facts.emailPlaceholder || isPlaceholderEmail(facts.email));
  return {
    canDelete: blockers.length === 0,
    blockers,
    subscriptionsToCancel: facts.liveSubscriptions,
    promotionalForfeitPaise: Math.max(0, Math.min(facts.walletPromotionalPaise, facts.walletBalancePaise)),
    maskedEmail: realEmail ? maskEmailAddress(facts.email) : null,
  };
}

async function requireFlag(): Promise<void> {
  if (!(await isFeatureEnabled(ACCOUNT_DELETION_FLAG))) throw featureNotAvailable(ACCOUNT_DELETION_FLAG);
}

/** The checks for the signed-in person. */
export async function deletionPrecheck(userId: string): Promise<DeletionPrecheck> {
  await requireFlag();
  return precheckFrom(await gatherDeletionFacts(userId));
}

export interface DeletionStatusView {
  precheck: DeletionPrecheck;
  latestRequest: Pick<AccountDeletionRequest, "id" | "status" | "requestedAt" | "completedAt" | "purgeAfter"> | null;
}

/** GET /api/profile/delete: the checks plus the latest request. */
export async function getDeletionStatus(userId: string): Promise<DeletionStatusView> {
  const precheck = await deletionPrecheck(userId);
  const [latest] = await db
    .select({
      id: accountDeletionRequests.id,
      status: accountDeletionRequests.status,
      requestedAt: accountDeletionRequests.requestedAt,
      completedAt: accountDeletionRequests.completedAt,
      purgeAfter: accountDeletionRequests.purgeAfter,
    })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.userId, userId))
    .orderBy(desc(accountDeletionRequests.requestedAt))
    .limit(1);
  return { precheck, latestRequest: latest ?? null };
}

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** Records a refused attempt: a BLOCKED row and an audit entry. */
async function recordBlocked(userId: string, role: UserRole, blockers: DeletionBlocker[], meta: RequestMeta): Promise<void> {
  await db.insert(accountDeletionRequests).values({
    userId,
    status: "BLOCKED",
    blockers,
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: AUDIT_ACTIONS.ACCOUNT_DELETION_BLOCKED,
    entityType: "user",
    entityId: userId,
    newValue: { blockers: blockers.map((b) => b.code) },
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
}

function blockedError(blockers: DeletionBlocker[]): AppError {
  return conflict("Your account cannot be deleted yet. Sort out the items listed first.", { blockers });
}

function renderCodeEmail(code: string, expiryMinutes: number) {
  const text =
    `Your code to delete your GoKesari account is ${code}. It expires in ${expiryMinutes} minutes.\n\n` +
    "If you did not ask to delete your account, ignore this email and sign in to check your account — nothing changes without this code.\n";
  const html =
    `<p>Your code to <strong>delete your GoKesari account</strong> is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>` +
    `<p>It expires in ${expiryMinutes} minutes.</p>` +
    "<p>If you did not ask to delete your account, ignore this email and sign in to check your account — nothing changes without this code.</p>";
  return { subject: "Your code to delete your GoKesari account", text, html };
}

/** POST /api/profile/delete/code: runs the checks, then emails the code to the account's address. */
export async function requestAccountDeletionCode(
  actor: { id: string; role: UserRole },
  meta: RequestMeta = {},
): Promise<{ maskedEmail: string; resendAfterSeconds: number; expiryMinutes: number; requestId: string }> {
  await requireFlag();
  const facts = await gatherDeletionFacts(actor.id);
  const blockers = blockersFrom(facts);
  if (blockers.length > 0) {
    await recordBlocked(actor.id, facts.role, blockers, meta);
    throw blockedError(blockers);
  }

  const sent = await requestAccountActionOtp({
    email: facts.email,
    userId: actor.id,
    purpose: "ACCOUNT_DELETE",
    ip: meta.ip ?? null,
    render: renderCodeEmail,
  });

  // One open request per person: a resend refreshes it.
  const [open] = await db
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(and(eq(accountDeletionRequests.userId, actor.id), eq(accountDeletionRequests.status, "REQUESTED")))
    .orderBy(desc(accountDeletionRequests.requestedAt))
    .limit(1);
  let requestId: string;
  if (open) {
    await db
      .update(accountDeletionRequests)
      .set({ requestedAt: new Date(), blockers: [], ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null })
      .where(eq(accountDeletionRequests.id, open.id));
    requestId = open.id;
  } else {
    const [row] = await db
      .insert(accountDeletionRequests)
      .values({ userId: actor.id, status: "REQUESTED", ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null })
      .returning({ id: accountDeletionRequests.id });
    requestId = row.id;
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: facts.role,
    action: AUDIT_ACTIONS.ACCOUNT_DELETION_REQUESTED,
    entityType: "user",
    entityId: actor.id,
    newValue: { requestId, subscriptionsToCancel: facts.liveSubscriptions },
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return { ...sent, requestId };
}


/* ------------------------------------------------------------ the reason */

/** 0199: the reasons offered on the page (a reason is now required). "OTHER" needs the person's own words. */
export const ACCOUNT_DELETION_REASONS = [
  { code: "NOT_USING", label: "I don't use GoKesari any more" },
  { code: "PRIVACY", label: "I am worried about my privacy or data" },
  { code: "TOO_MANY_MESSAGES", label: "Too many messages or notifications" },
  { code: "BAD_EXPERIENCE", label: "Bad experience with orders or delivery" },
  { code: "OTHER_ACCOUNT", label: "I have another GoKesari account" },
  { code: "OTHER", label: "Other" },
] as const;
export type AccountDeletionReasonCode = (typeof ACCOUNT_DELETION_REASONS)[number]["code"];

/** Pure: checks the picked reason (and the words for "Other"); returns what is stored. */
export function normaliseDeletionReason(input: { reasonCode?: string | null; reason?: string | null }): {
  reasonCode: AccountDeletionReasonCode;
  reason: string;
} {
  const words = input.reason?.trim().slice(0, 500) ?? "";
  // A reason typed without picking one counts as "Other" (older app screens send only the words).
  const code = input.reasonCode?.trim() || (words ? "OTHER" : "");
  const picked = ACCOUNT_DELETION_REASONS.find((r) => r.code === code);
  if (!picked) {
    throw validationFailed("Tell us why you are leaving: pick a reason.", { fields: { reasonCode: "Pick a reason." } });
  }
  if (picked.code === "OTHER") {
    if (words.length < 3) {
      throw validationFailed("Tell us in a few words why you are leaving.", { fields: { reason: "Write your reason." } });
    }
    return { reasonCode: "OTHER", reason: words };
  }
  return { reasonCode: picked.code, reason: words ? `${picked.label} — ${words}` : picked.label };
}

/** Pure: when the cooling-off period of an account hidden at `now` ends. */
export function coolingOffEnd(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** "24 Feb 2027" in India time, for the emails and screens. */
export function formatPurgeDate(value: Date): string {
  return value.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}

/* --------------------------------------------------------- anonymisation */

/** The placeholder address a deleted account keeps (users.email is NOT NULL and unique). */
export function anonymisedEmail(userId: string): string {
  return `deleted+${userId}@deleted.invalid`;
}

/** Pure: the user-row patch that anonymises an account. */
export function anonymisedUserPatch(userId: string, now: Date) {
  return {
    name: null,
    email: anonymisedEmail(userId),
    emailVerified: null,
    emailPlaceholder: true,
    image: null,
    phone: null,
    phoneE164: null,
    phoneVerifiedAt: null,
    gender: null,
    status: "DELETED" as const,
    deletedAt: now,
    updatedAt: now,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const SUBSCRIPTION_CANCEL_REASON = "Account deleted by the customer.";

/** Cancels any subscription still live, inside the transaction (no notification: the account is going). */
async function cancelLiveSubscriptionsInTx(tx: Tx, userId: string, now: Date, actorId: string | null): Promise<number> {
  const rows = await tx
    .update(subscriptions)
    .set({ status: "CANCELLED", cancelledAt: now, cancellationReason: SUBSCRIPTION_CANCEL_REASON, nextDeliveryDate: null, renewalReason: null, renewalDueDate: null, updatedAt: now, statusActorId: actorId })
    .where(and(eq(subscriptions.userId, userId), notInArray(subscriptions.status, [...FINAL_SUBSCRIPTION_STATUSES])))
    .returning({ id: subscriptions.id });
  return rows.length;
}

/**
 * Anonymises one account inside the caller's transaction (the account row must
 * already be locked). Run by the daily job once the cooling-off period is over.
 */
export async function anonymiseInTx(tx: Tx, userId: string, now: Date): Promise<void> {
  await tx.update(users).set(anonymisedUserPatch(userId, now)).where(eq(users.id, userId));

  // Saved addresses: soft-deleted and stripped. Orders keep their own address snapshot.
  await tx
    .update(addresses)
    .set({
      label: null,
      recipientName: null,
      recipientPhone: null,
      line1: "[deleted]",
      line2: null,
      area: null,
      landmark: null,
      deliveryInstructions: null,
      latitude: null,
      longitude: null,
      isDefault: false,
      deletedAt: now,
    })
    .where(eq(addresses.userId, userId));

  await tx.delete(pushTokens).where(eq(pushTokens.userId, userId));

  // The customer's own refund accounts (not a shop's). One a refund or payout record points
  // at is retired, not deleted: that record is kept for legal retention.
  await tx
    .delete(bankAccounts)
    .where(
      and(
        eq(bankAccounts.userId, userId),
        isNull(bankAccounts.shopId),
        sql`NOT EXISTS (SELECT 1 FROM ${bankRefundRequests} WHERE ${bankRefundRequests.bankAccountId} = ${bankAccounts.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${riderBankTransfers} WHERE ${riderBankTransfers.bankAccountId} = ${bankAccounts.id})`,
      ),
    );
  await tx
    .update(bankAccounts)
    .set({ isCurrent: false, supersededAt: now, updatedAt: now })
    .where(and(eq(bankAccounts.userId, userId), isNull(bankAccounts.shopId), eq(bankAccounts.isCurrent, true)));

  // A rider profile stops taking work for good; its KYC and earnings stay (tax records, rule accountDeletion.retentionYears).
  await tx
    .update(deliveryPartners)
    .set({ status: "DEACTIVATED", isOnline: false, availability: "OFFLINE", updatedAt: now })
    .where(and(eq(deliveryPartners.userId, userId), isNull(deliveryPartners.deletedAt), notInArray(deliveryPartners.status, ["DEACTIVATED", "REJECTED"])));
}

/* --------------------------------------------- confirm → cooling-off period */

export interface DeleteAccountResult {
  /** The account is hidden now and will be deleted on `purgeAfter`. */
  scheduled: true;
  requestId: string;
  purgeAfter: Date;
  subscriptionsCancelled: number;
}

/**
 * POST /api/profile/delete: the signed-in person confirms the deletion. Since
 * 0199 the account is hidden at once and anonymised by the daily job after the
 * cooling-off period; signing in again during that time offers a restore.
 */
export async function deleteAccount(
  actor: { id: string; role: UserRole },
  input: { code: string; confirmText: string; reason?: string | null; reasonCode?: string | null },
  meta: RequestMeta = {},
  deps: {
    cancelSubscription?: (id: string, reason: string, actor: { id: string; role: UserRole }) => Promise<unknown>;
    goOffline?: (userId: string) => Promise<unknown>;
    now?: () => Date;
  } = {},
): Promise<DeleteAccountResult> {
  await requireFlag();
  if (input.confirmText.trim() !== DELETE_CONFIRM_TEXT) {
    throw validationFailed(`Type ${DELETE_CONFIRM_TEXT} in capital letters to confirm.`, {
      fields: { confirmText: `Type ${DELETE_CONFIRM_TEXT} exactly.` },
    });
  }
  const { reasonCode, reason } = normaliseDeletionReason(input);

  const [before] = await db.select().from(users).where(eq(users.id, actor.id));
  if (!before || before.status !== "ACTIVE" || before.deletedAt) throw forbidden();

  await verifyAccountActionOtp({
    email: before.email,
    userId: actor.id,
    purpose: "ACCOUNT_DELETE",
    code: input.code,
    ip: meta.ip ?? null,
  });

  const facts = await gatherDeletionFacts(actor.id);
  const blockers = blockersFrom(facts);
  if (blockers.length > 0) {
    await recordBlocked(actor.id, facts.role, blockers, meta);
    throw blockedError(blockers);
  }

  // Subscriptions first, each through the normal cancel (its own audit, event and
  // schedule clean-up). Any left live (a race) are cancelled inside the transaction.
  const live = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, actor.id), notInArray(subscriptions.status, [...FINAL_SUBSCRIPTION_STATUSES])));
  const cancel = deps.cancelSubscription ?? (await import("./subscriptions")).cancelSubscription;
  let subscriptionsCancelled = 0;
  for (const s of live) {
    try {
      await cancel(s.id, SUBSCRIPTION_CANCEL_REASON, actor);
      subscriptionsCancelled++;
    } catch (error) {
      console.error("[account-deletion] could not cancel subscription", s.id, error);
    }
  }

  const { coolingOffDays } = await getRule("accountDeletion");
  const now = deps.now?.() ?? new Date();
  const purgeAfter = coolingOffEnd(now, coolingOffDays);

  const requestId = await db.transaction(async (tx) => {
    // Lock the account row: a second confirm, a sign-in update or a role change waits.
    const [locked] = await tx.select().from(users).where(eq(users.id, actor.id)).for("update");
    if (!locked || locked.status !== "ACTIVE" || locked.deletedAt) throw conflict("This account is already being deleted.");

    const again = blockersFrom(await gatherDeletionFacts(actor.id, tx));
    if (again.length > 0) throw blockedError(again);

    subscriptionsCancelled += await cancelLiveSubscriptionsInTx(tx, actor.id, now, actor.id);

    // Hidden: no sign-in, no session, not offered to anyone (status PENDING_DELETION).
    await tx.update(users).set({ status: "PENDING_DELETION", updatedAt: now }).where(eq(users.id, actor.id));
    // No app notifications while hidden (the app registers its token again after a restore).
    await tx.delete(pushTokens).where(eq(pushTokens.userId, actor.id));
    // A rider profile stops taking work; its status before is kept to switch it back on a restore.
    const riders = await tx
      .select({ id: deliveryPartners.id, status: deliveryPartners.status })
      .from(deliveryPartners)
      .where(and(eq(deliveryPartners.userId, actor.id), isNull(deliveryPartners.deletedAt), notInArray(deliveryPartners.status, ["DEACTIVATED", "REJECTED"])));
    if (riders.length > 0) {
      await tx
        .update(deliveryPartners)
        .set({ status: "DEACTIVATED", updatedAt: now })
        .where(inArray(deliveryPartners.id, riders.map((r) => r.id)));
    }

    const values = {
      status: "COOLING_OFF" as const,
      reason,
      reasonCode,
      coolingStartedAt: now,
      purgeAfter,
      hiddenState: { riderStatuses: riders },
      blockers: [],
    };
    const [open] = await tx
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.userId, actor.id), eq(accountDeletionRequests.status, "REQUESTED")))
      .orderBy(desc(accountDeletionRequests.requestedAt))
      .limit(1);
    let id: string;
    if (open) {
      await tx.update(accountDeletionRequests).set(values).where(eq(accountDeletionRequests.id, open.id));
      id = open.id;
    } else {
      const [row] = await tx
        .insert(accountDeletionRequests)
        .values({ userId: actor.id, ...values, ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null })
        .returning({ id: accountDeletionRequests.id });
      id = row.id;
    }

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: locked.role,
        action: AUDIT_ACTIONS.ACCOUNT_DELETION_COOLING_OFF,
        entityType: "user",
        entityId: actor.id,
        previousValue: { status: locked.status },
        newValue: { status: "PENDING_DELETION", requestId: id, purgeAfter: purgeAfter.toISOString(), coolingOffDays, subscriptionsCancelled, reasonCode, reason, ridersDeactivated: riders.length },
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return id;
  });

  // After commit: side effects that may fail without undoing the request.
  const offline = deps.goOffline ?? (await import("./delivery-partners")).goOfflineOnSignOut;
  await Promise.resolve(offline(actor.id)).catch((error: unknown) => console.error("[account-deletion] could not set the rider offline", error));

  if (!before.emailPlaceholder && !isPlaceholderEmail(before.email)) {
    const date = formatPurgeDate(purgeAfter);
    void sendEmail({
      to: before.email,
      subject: `Your GoKesari account will be deleted on ${date}`,
      text:
        `As you asked, your GoKesari account is now hidden and will be deleted permanently on ${date}.\n\n` +
        "Until then you can change your mind: sign in with your email address and the code we send you, then choose \"Restore my account\".\n\n" +
        "Order, invoice and payment records are kept for the period the law requires (tax and consumer law), without being used for anything else.\n\n" +
        "If you did not ask for this, sign in now to restore your account and contact support.\n",
      html:
        `<p>As you asked, your GoKesari account is now hidden and will be <strong>deleted permanently on ${date}</strong>.</p>` +
        "<p>Until then you can change your mind: sign in with your email address and the code we send you, then choose <strong>Restore my account</strong>.</p>" +
        "<p>Order, invoice and payment records are kept for the period the law requires (tax and consumer law), without being used for anything else.</p>" +
        "<p>If you did not ask for this, sign in now to restore your account and contact support.</p>",
    }).catch((error) => console.error("[account-deletion] cooling-off email failed", error));
  }

  return { scheduled: true, requestId, purgeAfter, subscriptionsCancelled };
}

/* ------------------------------------------------------------- restoring */

/** The request that keeps an account hidden: COOLING_OFF, or BLOCKED at purge time (it has a purge date). */
async function openCoolingRequest(userId: string, client: DbClient = db) {
  const [row] = await client
    .select()
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        inArray(accountDeletionRequests.status, ["COOLING_OFF", "BLOCKED"]),
        isNotNull(accountDeletionRequests.purgeAfter),
      ),
    )
    .orderBy(desc(accountDeletionRequests.coolingStartedAt))
    .limit(1);
  return row ?? null;
}

export interface PendingDeletionView {
  requestId: string;
  purgeAfter: Date;
  maskedEmail: string;
}

/** For the restore screen: the hidden account's request, or null when the account is not hidden. */
export async function getPendingDeletion(userId: string): Promise<PendingDeletionView | null> {
  const [user] = await db.select({ status: users.status, email: users.email }).from(users).where(eq(users.id, userId));
  if (!user || user.status !== "PENDING_DELETION") return null;
  const request = await openCoolingRequest(userId);
  if (!request?.purgeAfter) return null;
  return { requestId: request.id, purgeAfter: request.purgeAfter, maskedEmail: maskEmailAddress(user.email) };
}

/**
 * Switches a hidden account back on: ACTIVE again, a rider profile back to its
 * status before, the request CANCELLED (who and why kept), audited, and an email
 * after commit. `by` is SELF (the person, at sign-in) or ADMIN (with a note).
 * Works with the flag off too, so no one is left hidden if it is switched off.
 */
export async function restoreAccount(
  userId: string,
  actor: { id: string; role: UserRole },
  options: { by: "SELF" | "ADMIN"; note?: string | null; ip?: string | null; userAgent?: string | null; now?: Date } = { by: "SELF" },
): Promise<{ restored: true; requestId: string }> {
  const now = options.now ?? new Date();
  const note = options.note?.trim().slice(0, 500) || null;
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!locked || locked.status !== "PENDING_DELETION" || locked.deletedAt) {
      throw conflict("This account is not waiting to be deleted, so there is nothing to restore.");
    }
    const request = await openCoolingRequest(userId, tx);
    if (!request) throw conflict("This account is not waiting to be deleted, so there is nothing to restore.");

    await tx.update(users).set({ status: "ACTIVE", updatedAt: now }).where(eq(users.id, userId));
    // Riders switched off when the account was hidden go back to their status before (still offline).
    for (const rider of request.hiddenState?.riderStatuses ?? []) {
      await tx
        .update(deliveryPartners)
        .set({ status: rider.status as (typeof deliveryPartners.$inferSelect)["status"], updatedAt: now })
        .where(and(eq(deliveryPartners.id, rider.id), eq(deliveryPartners.status, "DEACTIVATED")));
    }
    await tx
      .update(accountDeletionRequests)
      .set({ status: "CANCELLED", cancelledAt: now, cancelledBy: actor.id, cancelNote: note ?? (options.by === "SELF" ? "Restored by the person at sign-in." : null) })
      .where(eq(accountDeletionRequests.id, request.id));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: options.by === "SELF" ? locked.role : actor.role,
        action: AUDIT_ACTIONS.ACCOUNT_DELETION_RESTORED,
        entityType: "user",
        entityId: userId,
        previousValue: { status: "PENDING_DELETION", requestStatus: request.status, purgeAfter: request.purgeAfter?.toISOString() ?? null },
        newValue: { status: "ACTIVE", requestId: request.id, by: options.by, note },
        ipAddress: options.ip ?? null,
        userAgent: options.userAgent ?? null,
      },
      tx,
    );
    return { requestId: request.id, email: locked.email, placeholder: locked.emailPlaceholder };
  });

  if (!result.placeholder && !isPlaceholderEmail(result.email)) {
    const how = options.by === "SELF" ? "You restored your GoKesari account." : "A GoKesari administrator has cancelled the deletion of your account.";
    void sendEmail({
      to: result.email,
      subject: "Your GoKesari account has been restored",
      text: `${how} It will not be deleted, and you can sign in and use it as before.\n\nSubscriptions cancelled when you asked for the deletion stay cancelled; you can start them again.\n\nIf you did not do this, contact support.\n`,
      html: `<p>${how} It will not be deleted, and you can sign in and use it as before.</p><p>Subscriptions cancelled when you asked for the deletion stay cancelled; you can start them again.</p><p>If you did not do this, contact support.</p>`,
    }).catch((error) => console.error("[account-deletion] restore email failed", error));
  }
  return { restored: true, requestId: result.requestId };
}

/** Admin → Account deletions: an ADMIN cancels a request in its cooling-off period (restores the account), with a note. */
export async function adminCancelDeletion(
  actor: { id: string; role: UserRole },
  requestId: string,
  note: string,
): Promise<{ restored: true; requestId: string }> {
  if (!can(actor.role, PERMISSIONS.USER_SUSPEND)) throw forbidden("Only an administrator can cancel an account deletion.");
  const trimmed = note.trim();
  if (trimmed.length < 3) throw validationFailed("Write a note: why is the deletion cancelled?", { fields: { note: "A note is required." } });
  const [request] = await db
    .select({ userId: accountDeletionRequests.userId, status: accountDeletionRequests.status })
    .from(accountDeletionRequests)
    .where(eq(accountDeletionRequests.id, requestId));
  if (!request) throw notFound("Account deletion request");
  if (request.status !== "COOLING_OFF" && request.status !== "BLOCKED") throw conflict("Only a request in its cooling-off period can be cancelled.");
  return restoreAccount(request.userId, actor, { by: "ADMIN", note: trimmed });
}

/* ---------------------------------------------- restore ticket (sign-in) */

/** The cookie the sign-in page sets for a hidden account (httpOnly, 15 minutes). */
export const RESTORE_COOKIE = "gk_account_restore";
export const RESTORE_TICKET_TTL_MS = 15 * 60_000;

function restoreMac(payload: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`account-restore:${payload}`).digest("hex");
}

/** Proof that the person just signed in with a code for this hidden account. Never contains personal data. */
export function createRestoreTicket(userId: string, now: number = Date.now()): string {
  const payload = `${userId}.${now + RESTORE_TICKET_TTL_MS}`;
  return `${payload}.${restoreMac(payload)}`;
}

export function readRestoreTicket(ticket: string | null | undefined, now: number = Date.now()): string | null {
  const parts = (ticket ?? "").split(".");
  if (parts.length !== 3) return null;
  const [userId, expires, mac] = parts;
  const expected = restoreMac(`${userId}.${expires}`);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (!(Number(expires) > now)) return null;
  return userId;
}

/* ------------------------------------------------------- the daily purge */

export interface PurgeRunResult {
  due: number;
  completed: number;
  blocked: number;
  skipped: number;
  errors: string[];
}

/**
 * Daily job (cron/schedule.ts "account-deletion-purge"): every hidden account
 * whose cooling-off period is over is checked again on the locked row. Clear →
 * anonymised, request COMPLETED, completion email to the original address after
 * commit. A blocker appeared (an open order, money in the wallet, rider dues …)
 * → request BLOCKED with the blockers, ops alerted the first time, nothing
 * purged; it is retried every day until it clears or an admin cancels it.
 * Runs whatever the flag (a person who asked must not stay hidden for ever).
 */
export async function runDueAccountPurges(now: Date = new Date(), options: { limit?: number } = {}): Promise<PurgeRunResult> {
  const due = await db
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        inArray(accountDeletionRequests.status, ["COOLING_OFF", "BLOCKED"]),
        isNotNull(accountDeletionRequests.purgeAfter),
        lte(accountDeletionRequests.purgeAfter, now),
      ),
    )
    .orderBy(accountDeletionRequests.purgeAfter)
    .limit(options.limit ?? 200);

  const result: PurgeRunResult = { due: due.length, completed: 0, blocked: 0, skipped: 0, errors: [] };
  for (const { id } of due) {
    try {
      const outcome = await purgeOne(id, now);
      if (outcome === "COMPLETED") result.completed++;
      else if (outcome === "BLOCKED") result.blocked++;
      else result.skipped++;
    } catch (error) {
      result.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      console.error("[account-deletion] purge failed", id, error);
    }
  }
  return result;
}

async function purgeOne(requestId: string, now: Date): Promise<"COMPLETED" | "BLOCKED" | "SKIPPED"> {
  const outcome = await db.transaction(async (tx) => {
    const [request] = await tx.select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId)).for("update");
    if (!request || (request.status !== "COOLING_OFF" && request.status !== "BLOCKED") || !request.purgeAfter || request.purgeAfter > now) {
      return { kind: "SKIPPED" as const };
    }
    const [locked] = await tx.select().from(users).where(eq(users.id, request.userId)).for("update");
    if (!locked || locked.status !== "PENDING_DELETION" || locked.deletedAt) {
      // Restored some other way, or already gone: the request is closed so it is not picked again.
      await tx
        .update(accountDeletionRequests)
        .set(locked?.status === "DELETED" ? { status: "COMPLETED", completedAt: now } : { status: "CANCELLED", cancelledAt: now, cancelNote: "The account was no longer hidden at purge time." })
        .where(eq(accountDeletionRequests.id, requestId));
      return { kind: "SKIPPED" as const };
    }

    const blockers = blockersFrom(await gatherDeletionFacts(request.userId, tx));
    if (blockers.length > 0) {
      const firstTime = request.status === "COOLING_OFF";
      await tx.update(accountDeletionRequests).set({ status: "BLOCKED", blockers }).where(eq(accountDeletionRequests.id, requestId));
      if (firstTime) {
        await recordAudit(
          {
            action: AUDIT_ACTIONS.ACCOUNT_DELETION_PURGE_BLOCKED,
            entityType: "user",
            entityId: request.userId,
            newValue: { requestId, blockers: blockers.map((b) => b.code) },
          },
          tx,
        );
      }
      return { kind: "BLOCKED" as const, firstTime, blockers, userId: request.userId };
    }

    const subscriptionsCancelled = await cancelLiveSubscriptionsInTx(tx, request.userId, now, null);
    await anonymiseInTx(tx, request.userId, now);
    await tx
      .update(accountDeletionRequests)
      .set({ status: "COMPLETED", completedAt: now, blockers: [] })
      .where(eq(accountDeletionRequests.id, requestId));
    await recordAudit(
      {
        action: AUDIT_ACTIONS.ACCOUNT_DELETED,
        entityType: "user",
        entityId: request.userId,
        previousValue: { email: maskEmailAddress(locked.email), status: locked.status },
        newValue: { status: "DELETED", requestId, subscriptionsCancelled, reasonCode: request.reasonCode, reason: request.reason, coolingStartedAt: request.coolingStartedAt?.toISOString() ?? null },
      },
      tx,
    );
    return { kind: "COMPLETED" as const, email: locked.email, placeholder: locked.emailPlaceholder };
  });

  // After commit.
  if (outcome.kind === "COMPLETED" && !outcome.placeholder && !isPlaceholderEmail(outcome.email)) {
    await sendEmail({
      to: outcome.email,
      subject: "Your GoKesari account has been deleted",
      text:
        "Your GoKesari account has been deleted as you asked. Your name, contact details, saved addresses and saved bank details have been removed.\n\n" +
        "Order, invoice and payment records are kept for the period the law requires (tax and consumer law), without being used for anything else.\n\n" +
        "You can create a new account with this email address at any time. If you did not delete your account, contact support immediately.\n",
      html:
        "<p>Your GoKesari account has been deleted as you asked. Your name, contact details, saved addresses and saved bank details have been removed.</p>" +
        "<p>Order, invoice and payment records are kept for the period the law requires (tax and consumer law), without being used for anything else.</p>" +
        "<p>You can create a new account with this email address at any time. If you did not delete your account, contact support immediately.</p>",
    }).catch((error) => console.error("[account-deletion] completion email failed", error));
  }
  if (outcome.kind === "BLOCKED" && outcome.firstTime) {
    const list = outcome.blockers.map((b) => `- ${b.code}: ${b.message}`).join("\n");
    console.warn("[account-deletion] purge blocked", requestId, outcome.blockers.map((b) => b.code));
    await sendEmail({
      to: getEnv().SUPER_ADMIN_EMAIL,
      subject: "Account deletion held: a blocker appeared during the cooling-off period",
      text:
        `The account deletion request ${requestId} (account id ${outcome.userId}) reached the end of its cooling-off period, but the account cannot be deleted yet:\n\n${list}\n\n` +
        "Nothing was deleted; the account stays hidden and the job tries again every day. Sort the items out, or cancel the deletion (restores the account) at Admin → Consent record → Account deletions.\n",
    }).catch((error) => console.error("[account-deletion] ops alert email failed", error));
  }
  return outcome.kind;
}

/* ------------------------------------------------------------------ admin */

export interface DeletionRequestRow {
  id: string;
  userId: string;
  status: AccountDeletionRequest["status"];
  blockers: DeletionBlocker[];
  reason: string | null;
  reasonCode: string | null;
  requestedAt: Date;
  coolingStartedAt: Date | null;
  purgeAfter: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelNote: string | null;
  /** Only for an account still hidden (not yet anonymised), and only when `includePersonal` (ADMIN). */
  person: { name: string | null; email: string } | null;
}

/**
 * Admin → Consent record → Account deletions. A completed request's account is
 * anonymised, so only its id is shown. An account still in its cooling-off
 * period keeps its name and email, shown to admins only (`includePersonal`).
 */
export async function listDeletionRequests(
  options: { status?: AccountDeletionRequest["status"]; limit?: number; includePersonal?: boolean } = {},
): Promise<DeletionRequestRow[]> {
  const rows = await db
    .select({
      id: accountDeletionRequests.id,
      userId: accountDeletionRequests.userId,
      status: accountDeletionRequests.status,
      blockers: accountDeletionRequests.blockers,
      reason: accountDeletionRequests.reason,
      reasonCode: accountDeletionRequests.reasonCode,
      requestedAt: accountDeletionRequests.requestedAt,
      coolingStartedAt: accountDeletionRequests.coolingStartedAt,
      purgeAfter: accountDeletionRequests.purgeAfter,
      completedAt: accountDeletionRequests.completedAt,
      cancelledAt: accountDeletionRequests.cancelledAt,
      cancelNote: accountDeletionRequests.cancelNote,
      userStatus: users.status,
      name: users.name,
      email: users.email,
    })
    .from(accountDeletionRequests)
    .leftJoin(users, eq(users.id, accountDeletionRequests.userId))
    .where(options.status ? eq(accountDeletionRequests.status, options.status) : undefined)
    .orderBy(desc(accountDeletionRequests.requestedAt))
    .limit(Math.min(options.limit ?? 100, 500));
  return rows.map(({ userStatus, name, email, ...r }) => ({
    ...r,
    blockers: (r.blockers ?? []) as DeletionBlocker[],
    person:
      options.includePersonal && userStatus === "PENDING_DELETION" && email && (r.status === "COOLING_OFF" || r.status === "BLOCKED")
        ? { name, email }
        : null,
  }));
}
