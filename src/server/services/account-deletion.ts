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
 *  3. `deleteAccount` checks the code and the typed word DELETE, cancels the
 *     subscriptions, then in one transaction re-runs the checks on the locked
 *     account row and anonymises it.
 *
 * Anonymised: the user row (name, email → deleted+<id>@deleted.invalid, phone,
 * photo, status DELETED, deletedAt), saved addresses, push tokens and the
 * customer's own saved bank / UPI accounts (deleted, or retired when a refund
 * record points at them). Consents are kept as history.
 *
 * Kept untouched for legal retention (GST, Income-tax, payment and consumer
 * law): orders and their address snapshots, invoices, payments and payment
 * intents, wallet and wallet transactions, refunds and bank refund requests,
 * ledgers, TDS/TCS records, returns, disputes, rider earnings / payouts / KYC,
 * shop records, audit logs and the consent trail. See the README.
 *
 * Sessions: auth is stateless JWT re-read against the user row on every
 * request; a DELETED row ends every session the person has, on every device
 * (auth-sessions.ts readSession drops it). The page then signs the browser out,
 * which also lists that session in revoked_sessions (endSession).
 *
 * External side effects (the completion email, setting a rider offline) run
 * after the transaction commits.
 */
import { and, count, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { maskEmailAddress } from "@/lib/contact";
import { AppError, conflict, forbidden, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
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
  latestRequest: Pick<AccountDeletionRequest, "id" | "status" | "requestedAt" | "completedAt"> | null;
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

export interface DeleteAccountResult {
  deleted: true;
  requestId: string;
  subscriptionsCancelled: number;
}

/** POST /api/profile/delete: deletes (anonymises) the signed-in person's account. */
export async function deleteAccount(
  actor: { id: string; role: UserRole },
  input: { code: string; confirmText: string; reason?: string | null },
  meta: RequestMeta = {},
  deps: {
    cancelSubscription?: (id: string, reason: string, actor: { id: string; role: UserRole }) => Promise<unknown>;
    goOffline?: (userId: string) => Promise<unknown>;
  } = {},
): Promise<DeleteAccountResult> {
  await requireFlag();
  if (input.confirmText.trim() !== DELETE_CONFIRM_TEXT) {
    throw validationFailed(`Type ${DELETE_CONFIRM_TEXT} in capital letters to confirm.`, {
      fields: { confirmText: `Type ${DELETE_CONFIRM_TEXT} exactly.` },
    });
  }
  const reason = input.reason?.trim().slice(0, 500) || null;

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
  const reasonText = "Account deleted by the customer.";
  const live = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, actor.id), notInArray(subscriptions.status, [...FINAL_SUBSCRIPTION_STATUSES])));
  const cancel = deps.cancelSubscription ?? (await import("./subscriptions")).cancelSubscription;
  let subscriptionsCancelled = 0;
  for (const s of live) {
    try {
      await cancel(s.id, reasonText, actor);
      subscriptionsCancelled++;
    } catch (error) {
      console.error("[account-deletion] could not cancel subscription", s.id, error);
    }
  }

  const now = new Date();
  const requestId = await db.transaction(async (tx) => {
    // Lock the account row: a second delete, a sign-in update or a role change waits.
    const [locked] = await tx.select().from(users).where(eq(users.id, actor.id)).for("update");
    if (!locked || locked.status !== "ACTIVE" || locked.deletedAt) throw conflict("This account has already been deleted.");

    const again = blockersFrom(await gatherDeletionFacts(actor.id, tx));
    if (again.length > 0) throw blockedError(again);

    const stragglers = await tx
      .update(subscriptions)
      .set({ status: "CANCELLED", cancelledAt: now, cancellationReason: reasonText, nextDeliveryDate: null, renewalReason: null, renewalDueDate: null, updatedAt: now, statusActorId: actor.id })
      .where(and(eq(subscriptions.userId, actor.id), notInArray(subscriptions.status, [...FINAL_SUBSCRIPTION_STATUSES])))
      .returning({ id: subscriptions.id });
    subscriptionsCancelled += stragglers.length;

    await tx.update(users).set(anonymisedUserPatch(actor.id, now)).where(eq(users.id, actor.id));

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
      .where(eq(addresses.userId, actor.id));

    await tx.delete(pushTokens).where(eq(pushTokens.userId, actor.id));

    // The customer's own refund accounts (not a shop's). One a refund or payout record points
    // at is retired, not deleted: that record is kept for legal retention.
    await tx
      .delete(bankAccounts)
      .where(
        and(
          eq(bankAccounts.userId, actor.id),
          isNull(bankAccounts.shopId),
          sql`NOT EXISTS (SELECT 1 FROM ${bankRefundRequests} WHERE ${bankRefundRequests.bankAccountId} = ${bankAccounts.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${riderBankTransfers} WHERE ${riderBankTransfers.bankAccountId} = ${bankAccounts.id})`,
        ),
      );
    await tx
      .update(bankAccounts)
      .set({ isCurrent: false, supersededAt: now, updatedAt: now })
      .where(and(eq(bankAccounts.userId, actor.id), isNull(bankAccounts.shopId), eq(bankAccounts.isCurrent, true)));

    // A rider profile stops taking work; its KYC and earnings stay (tax records).
    await tx
      .update(deliveryPartners)
      .set({ status: "DEACTIVATED", updatedAt: now })
      .where(and(eq(deliveryPartners.userId, actor.id), isNull(deliveryPartners.deletedAt), notInArray(deliveryPartners.status, ["DEACTIVATED", "REJECTED"])));

    const [open] = await tx
      .select({ id: accountDeletionRequests.id })
      .from(accountDeletionRequests)
      .where(and(eq(accountDeletionRequests.userId, actor.id), eq(accountDeletionRequests.status, "REQUESTED")))
      .orderBy(desc(accountDeletionRequests.requestedAt))
      .limit(1);
    let id: string;
    if (open) {
      await tx
        .update(accountDeletionRequests)
        .set({ status: "COMPLETED", completedAt: now, reason, blockers: [] })
        .where(eq(accountDeletionRequests.id, open.id));
      id = open.id;
    } else {
      const [row] = await tx
        .insert(accountDeletionRequests)
        .values({ userId: actor.id, status: "COMPLETED", completedAt: now, reason, ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null })
        .returning({ id: accountDeletionRequests.id });
      id = row.id;
    }

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: locked.role,
        action: AUDIT_ACTIONS.ACCOUNT_DELETED,
        entityType: "user",
        entityId: actor.id,
        previousValue: { email: maskEmailAddress(locked.email), status: locked.status },
        newValue: { status: "DELETED", requestId: id, subscriptionsCancelled, reason },
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
      tx,
    );
    return id;
  });

  // After commit: side effects that may fail without undoing the deletion.
  const offline = deps.goOffline ?? (await import("./delivery-partners")).goOfflineOnSignOut;
  await Promise.resolve(offline(actor.id)).catch((error: unknown) => console.error("[account-deletion] could not set the rider offline", error));

  if (!before.emailPlaceholder && !isPlaceholderEmail(before.email)) {
    void sendEmail({
      to: before.email,
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

  return { deleted: true, requestId, subscriptionsCancelled };
}

/* ------------------------------------------------------------------ admin */

export interface DeletionRequestRow {
  id: string;
  userId: string;
  status: AccountDeletionRequest["status"];
  blockers: DeletionBlocker[];
  reason: string | null;
  requestedAt: Date;
  completedAt: Date | null;
}

/** Admin → Consent record → Account deletions (read-only). No personal data: the account is anonymised. */
export async function listDeletionRequests(options: { status?: AccountDeletionRequest["status"]; limit?: number } = {}): Promise<DeletionRequestRow[]> {
  const rows = await db
    .select({
      id: accountDeletionRequests.id,
      userId: accountDeletionRequests.userId,
      status: accountDeletionRequests.status,
      blockers: accountDeletionRequests.blockers,
      reason: accountDeletionRequests.reason,
      requestedAt: accountDeletionRequests.requestedAt,
      completedAt: accountDeletionRequests.completedAt,
    })
    .from(accountDeletionRequests)
    .where(options.status ? eq(accountDeletionRequests.status, options.status) : undefined)
    .orderBy(desc(accountDeletionRequests.requestedAt))
    .limit(Math.min(options.limit ?? 100, 500));
  return rows.map((r) => ({ ...r, blockers: (r.blockers ?? []) as DeletionBlocker[] }));
}
