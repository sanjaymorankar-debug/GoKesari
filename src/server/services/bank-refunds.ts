/**
 * Refunds to a customer's bank (docs/four-features-2026-10, decided by the
 * owner on 9 Oct 2026; rule bankRefunds).
 *
 * Refunds still land in the GoKesari wallet at once, as before (cancellation,
 * an unavailable item, the pickup delivery fee, a refund after delivery). For
 * windowDays afterwards the customer can have that refund sent to their own
 * bank account instead:
 *
 *   REQUESTED   the amount leaves the wallet straight away (customer-funded
 *               money only — never promotional credit, never a top-up)
 *   PROCESSING  finance has sent it from the bank (optional step)
 *   PAID        finance recorded the bank's reference (UTR)
 *   FAILED      the transfer failed: the amount is back in the wallet
 *   CANCELLED   the customer changed their mind before finance sent it
 *
 * The account is the customer's current bank account, verified with ₹1
 * (bank-accounts.ts, rule bankAccounts.requireVerifiedForBankRefunds). Finance
 * sends the money the way it pays shop settlements — from the bank, then
 * records the reference — and can see the full account details only through
 * an audited look-up. One request per refund credit (unique index); every
 * wallet movement has its own idempotency key, so a repeated request or
 * decision never moves money twice. Customer money stays in the wallet
 * ledger; no finance-ledger entry is made (finance.ts journals only
 * platform, shop and rider money).
 */
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { maskAccountNumber } from "@/lib/bank-accounts";
import { formatPaise } from "@/lib/money";
import { decryptSecret } from "@/lib/pan-crypto";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  bankAccounts,
  bankRefundRequests,
  orders,
  users,
  walletTransactions,
  wallets,
  type BankAccount,
  type BankRefundRequest,
  type BankRefundStatus,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { assertCustomerBankRefundAllowed, currentBankAccount } from "./bank-accounts";
import { getRule } from "./settings";
import { applyWalletMutation } from "./wallet";

interface Actor {
  id: string;
  role: UserRole;
}

const accountLabelOf = (account: Pick<BankAccount, "method" | "accountNumberLast4" | "ifsc" | "upiIdMasked">): string =>
  account.method === "UPI" ? `UPI ID ${account.upiIdMasked}` : `${account.ifsc} ${maskAccountNumber(account.accountNumberLast4)}`;

/* ============================================================ customer */

export interface BankRefundCandidate {
  refundTransactionId: string;
  orderId: string | null;
  orderNumber: string | null;
  description: string;
  refundedAt: string;
  /** The customer-funded part of the refund. */
  refundPaise: number;
  /** What can be sent now: the refund, less anything already spent from the wallet. */
  sendablePaise: number;
}

export interface BankRefundView {
  id: string;
  status: BankRefundStatus;
  amountPaise: number;
  accountLabel: string;
  orderNumber: string | null;
  createdAt: string;
  paidAt: string | null;
  payoutReference: string | null;
  failureReason: string | null;
}

export interface CustomerBankRefunds {
  windowDays: number;
  expectedWorkingDays: number;
  minAmountPaise: number;
  /** The account a refund would go to (masked), and whether it can be used. */
  account: { label: string; status: BankAccount["status"]; usable: boolean } | null;
  candidates: BankRefundCandidate[];
  requests: BankRefundView[];
}

function toView(row: BankRefundRequest, orderNumber: string | null): BankRefundView {
  return {
    id: row.id,
    status: row.status,
    amountPaise: row.amountPaise,
    accountLabel: row.accountLabel,
    orderNumber,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    payoutReference: row.payoutReference,
    failureReason: row.failureReason,
  };
}

/** The wallet page's "Send a refund to your bank" section; null while the rule is off. */
export async function getCustomerBankRefunds(userId: string): Promise<CustomerBankRefunds | null> {
  const rules = await getRule("bankRefunds");
  if (!rules.enabled) return null;
  const [accountRules, account, [wallet]] = await Promise.all([
    getRule("bankAccounts"),
    currentBankAccount(userId, null),
    db.select().from(wallets).where(eq(wallets.userId, userId)),
  ]);
  const customerFunded = wallet ? wallet.balancePaise - wallet.promotionalBalancePaise : 0;
  const since = new Date(Date.now() - rules.windowDays * 86_400_000);

  const refunds = await db
    .select({ tx: walletTransactions, orderNumber: orders.orderNumber })
    .from(walletTransactions)
    .leftJoin(bankRefundRequests, eq(bankRefundRequests.refundTransactionId, walletTransactions.id))
    .leftJoin(orders, eq(orders.id, walletTransactions.orderId))
    .where(
      and(
        eq(walletTransactions.userId, userId),
        eq(walletTransactions.type, "REFUND"),
        gte(walletTransactions.createdAt, since),
        sql`${walletTransactions.amountPaise} - ${walletTransactions.promotionalAmountPaise} > 0`,
        isNull(bankRefundRequests.id),
      ),
    )
    .orderBy(desc(walletTransactions.createdAt))
    .limit(20);

  const requests = await db
    .select({ row: bankRefundRequests, orderNumber: orders.orderNumber })
    .from(bankRefundRequests)
    .leftJoin(orders, eq(orders.id, bankRefundRequests.orderId))
    .where(eq(bankRefundRequests.userId, userId))
    .orderBy(desc(bankRefundRequests.createdAt))
    .limit(20);

  return {
    windowDays: rules.windowDays,
    expectedWorkingDays: rules.expectedWorkingDays,
    minAmountPaise: rules.minAmountPaise,
    account: account
      ? {
          label: accountLabelOf(account),
          status: account.status,
          usable: account.status === "VERIFIED" || !accountRules.requireVerifiedForBankRefunds,
        }
      : null,
    candidates: refunds.map(({ tx, orderNumber }) => {
      const refundPaise = tx.amountPaise - tx.promotionalAmountPaise;
      return {
        refundTransactionId: tx.id,
        orderId: tx.orderId,
        orderNumber,
        description: tx.description,
        refundedAt: tx.createdAt.toISOString(),
        refundPaise,
        sendablePaise: Math.max(0, Math.min(refundPaise, customerFunded)),
      };
    }),
    requests: requests.map(({ row, orderNumber }) => toView(row, orderNumber)),
  };
}

/** The customer asks for one refund to be sent to their bank account. */
export async function requestBankRefund(userId: string, refundTransactionId: string, actor: Actor): Promise<BankRefundView> {
  const rules = await getRule("bankRefunds");
  if (!rules.enabled) throw conflict("Refunds to a bank account are not available.");
  const account = await assertCustomerBankRefundAllowed(userId);
  if (!account) throw conflict("Add a bank account in My Profile to receive refunds to your bank.");
  const accountLabel = accountLabelOf(account);

  const result = await db.transaction(async (tx) => {
    // Lock the wallet first: the amount depends on what is still in it.
    const [wallet] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for("update");
    if (!wallet) throw notFound("Wallet");
    const [refund] = await tx
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.id, refundTransactionId), eq(walletTransactions.userId, userId)));
    if (!refund || refund.type !== "REFUND") throw notFound("Refund");
    const [existing] = await tx.select().from(bankRefundRequests).where(eq(bankRefundRequests.refundTransactionId, refund.id));
    if (existing) {
      if (existing.status !== "CANCELLED" && existing.status !== "FAILED") return { row: existing, created: false, orderNumber: null as string | null };
      throw conflict("This refund was already sent back to your wallet — choose the newer refund to try again.");
    }
    if (refund.createdAt.getTime() < Date.now() - rules.windowDays * 86_400_000) {
      throw conflict(`Only refunds from the last ${rules.windowDays} days can be sent to a bank.`);
    }
    const refundPaise = refund.amountPaise - refund.promotionalAmountPaise;
    const amountPaise = Math.min(refundPaise, wallet.balancePaise - wallet.promotionalBalancePaise);
    if (refundPaise <= 0) throw conflict("This refund was promotional credit, which stays in the wallet.");
    if (amountPaise <= 0) throw conflict("This refund has already been spent from your wallet.");
    if (amountPaise < rules.minAmountPaise) {
      throw conflict(`At least ${formatPaise(rules.minAmountPaise)} is needed to send a refund to a bank.`);
    }
    const [order] = refund.orderId
      ? await tx.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, refund.orderId))
      : [];
    const orderNumber = order?.orderNumber ?? null;

    const debit = await applyWalletMutation(
      {
        userId,
        amountPaise,
        type: "MANUAL_DEBIT",
        // Customer-funded money only: promotional credit never leaves the wallet.
        promotionalAmountPaise: 0,
        idempotencyKey: `bank-refund:${refund.id}`,
        description: `Refund sent to your bank (${accountLabel})${orderNumber ? ` — order ${orderNumber}` : ""}`,
        orderId: refund.orderId,
        createdBy: actor.id,
      },
      tx,
    );
    const [row] = await tx
      .insert(bankRefundRequests)
      .values({
        userId,
        refundTransactionId: refund.id,
        orderId: refund.orderId,
        bankAccountId: account.id,
        amountPaise,
        accountLabel,
        accountHolderName: account.accountHolderName,
        debitTransactionId: debit.transaction.id,
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.BANK_REFUND_REQUESTED,
        entityType: "bank_refund_request",
        entityId: row.id,
        newValue: { amountPaise, refundTransactionId: refund.id, bankAccountId: account.id, accountLabel },
      },
      tx,
    );
    const [user] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId));
    await emitEvent(
      {
        type: "bank_refund.requested",
        subjectId: row.id,
        orderId: refund.orderId,
        actor,
        payload: {
          requestId: row.id,
          userId,
          customerName: user?.name ?? null,
          amountLabel: formatPaise(amountPaise),
          accountLabel,
          orderNumber,
          expectedWorkingDays: rules.expectedWorkingDays,
        },
        idempotencyKey: `bank-refund:${row.id}:requested`,
      },
      tx,
    );
    return { row, created: true, orderNumber };
  });
  return toView(result.row, result.orderNumber);
}

/** Gives the amount back to the wallet (failed transfer / cancelled request). Inside the caller's transaction. */
async function returnToWallet(tx: DbClient, row: BankRefundRequest, why: "failed" | "cancelled", actorId: string): Promise<string> {
  const back = await applyWalletMutation(
    {
      userId: row.userId,
      amountPaise: row.amountPaise,
      type: "REFUND",
      promotionalAmountPaise: 0,
      idempotencyKey: `bank-refund-return:${row.id}`,
      description: why === "failed" ? `Back in your wallet: the transfer to ${row.accountLabel} failed` : `Back in your wallet: refund to ${row.accountLabel} cancelled`,
      orderId: row.orderId,
      createdBy: actorId,
    },
    tx,
  );
  return back.transaction.id;
}

/** The customer cancels a request finance has not started on. */
export async function cancelBankRefund(requestId: string, actor: Actor): Promise<BankRefundView> {
  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(bankRefundRequests).where(eq(bankRefundRequests.id, requestId)).for("update");
    if (!current || current.userId !== actor.id) throw notFound("Refund to bank");
    if (current.status === "CANCELLED") return current;
    if (current.status !== "REQUESTED") throw conflict("This refund is already being sent and can no longer be cancelled.");
    const returnTransactionId = await returnToWallet(tx, current, "cancelled", actor.id);
    const now = new Date();
    const [updated] = await tx
      .update(bankRefundRequests)
      .set({ status: "CANCELLED", returnTransactionId, cancelledAt: now, failureReason: "Cancelled by the customer", updatedAt: now })
      .where(eq(bankRefundRequests.id, current.id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.BANK_REFUND_DECIDED,
        entityType: "bank_refund_request",
        entityId: current.id,
        previousValue: { status: current.status },
        newValue: { status: "CANCELLED", returnTransactionId },
      },
      tx,
    );
    return updated;
  });
  return toView(row, null);
}

/* ============================================================= finance */

export interface BankRefundAdminRow extends BankRefundView {
  customerName: string | null;
  customerEmail: string;
  accountHolderName: string;
  decidedAt: string | null;
}

export async function listBankRefundsForFinance(filter: { status?: BankRefundStatus; id?: string }, actor: Actor): Promise<BankRefundAdminRow[]> {
  if (!can(actor.role, PERMISSIONS.FINANCE_VIEW)) throw forbidden("You do not have access to refunds to bank.");
  const rows = await db
    .select({ row: bankRefundRequests, orderNumber: orders.orderNumber, name: users.name, email: users.email })
    .from(bankRefundRequests)
    .innerJoin(users, eq(users.id, bankRefundRequests.userId))
    .leftJoin(orders, eq(orders.id, bankRefundRequests.orderId))
    .where(
      and(
        filter.status ? eq(bankRefundRequests.status, filter.status) : undefined,
        filter.id ? eq(bankRefundRequests.id, filter.id) : undefined,
      ),
    )
    .orderBy(desc(bankRefundRequests.createdAt))
    .limit(500);
  return rows.map(({ row, orderNumber, name, email }) => ({
    ...toView(row, orderNumber),
    customerName: name,
    customerEmail: email,
    accountHolderName: row.accountHolderName,
    decidedAt: (row.paidAt ?? row.failedAt ?? row.processingAt ?? row.cancelledAt)?.toISOString() ?? null,
  }));
}

export type BankRefundDecision =
  | { action: "process" }
  | { action: "pay"; reference: string }
  | { action: "fail"; reason: string };

/** Finance: sent from the bank → paid with the bank's reference, or failed (back to the wallet). */
export async function decideBankRefund(requestId: string, decision: BankRefundDecision, actor: Actor): Promise<BankRefundAdminRow> {
  if (!can(actor.role, PERMISSIONS.FINANCE_MANAGE)) throw forbidden("Only finance can send refunds to a bank.");
  const reference = decision.action === "pay" ? decision.reference.trim() : null;
  const reason = decision.action === "fail" ? decision.reason.trim() : null;
  if (decision.action === "pay" && (!reference || reference.length < 4)) {
    throw validationFailed("Enter the bank's reference (UTR) for the transfer.", { fields: { reference: "Required." } });
  }
  if (decision.action === "fail" && (!reason || reason.length < 3)) {
    throw validationFailed("Say why the transfer failed.", { fields: { reason: "Required." } });
  }

  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(bankRefundRequests).where(eq(bankRefundRequests.id, requestId)).for("update");
    if (!current) throw notFound("Refund to bank");
    const open = current.status === "REQUESTED" || current.status === "PROCESSING";
    // A repeated decision (double click, retried request) answers with what was done.
    if (decision.action === "process" && current.status === "PROCESSING") return;
    if (decision.action === "pay" && current.status === "PAID") return;
    if (decision.action === "fail" && current.status === "FAILED") return;
    if (!open || (decision.action === "process" && current.status !== "REQUESTED")) {
      throw conflict(`This refund is ${current.status.toLowerCase()} and can no longer be changed.`);
    }

    const now = new Date();
    let set: Partial<BankRefundRequest>;
    if (decision.action === "process") set = { status: "PROCESSING", processingAt: now };
    else if (decision.action === "pay") set = { status: "PAID", paidAt: now, payoutReference: reference };
    else set = { status: "FAILED", failedAt: now, failureReason: reason, returnTransactionId: await returnToWallet(tx, current, "failed", actor.id) };
    await tx
      .update(bankRefundRequests)
      .set({ ...set, decidedBy: actor.id, updatedAt: now })
      .where(eq(bankRefundRequests.id, current.id));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.BANK_REFUND_DECIDED,
        entityType: "bank_refund_request",
        entityId: current.id,
        previousValue: { status: current.status },
        newValue: { status: set.status, reference, reason },
      },
      tx,
    );
    if (decision.action !== "process") {
      const [order] = current.orderId ? await tx.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, current.orderId)) : [];
      await emitEvent(
        {
          type: decision.action === "pay" ? "bank_refund.paid" : "bank_refund.returned",
          subjectId: current.id,
          orderId: current.orderId,
          actor,
          payload: {
            requestId: current.id,
            userId: current.userId,
            customerName: null,
            amountLabel: formatPaise(current.amountPaise),
            accountLabel: current.accountLabel,
            orderNumber: order?.orderNumber ?? null,
            reference,
            reason,
          },
          idempotencyKey: `bank-refund:${current.id}:${set.status}`,
        },
        tx,
      );
    }
  });

  const [row] = await listBankRefundsForFinance({ id: requestId }, actor);
  if (!row) throw notFound("Refund to bank");
  return row;
}

export interface BankRefundPayoutDetails {
  method: BankAccount["method"];
  accountHolderName: string;
  accountNumber: string | null;
  ifsc: string | null;
  upiId: string | null;
}

/** Finance: the full account details to send the money, for an open request. Audited. */
export async function revealBankRefundAccount(requestId: string, actor: Actor): Promise<BankRefundPayoutDetails> {
  if (!can(actor.role, PERMISSIONS.FINANCE_MANAGE)) throw forbidden("Only finance can see the full account details.");
  const [row] = await db
    .select({ request: bankRefundRequests, account: bankAccounts })
    .from(bankRefundRequests)
    .innerJoin(bankAccounts, eq(bankAccounts.id, bankRefundRequests.bankAccountId))
    .where(eq(bankRefundRequests.id, requestId));
  if (!row) throw notFound("Refund to bank");
  if (row.request.status !== "REQUESTED" && row.request.status !== "PROCESSING") {
    throw conflict("The account details are shown only while the refund is still to be sent.");
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BANK_REFUND_DETAILS_VIEWED,
    entityType: "bank_refund_request",
    entityId: requestId,
    newValue: { bankAccountId: row.account.id },
  });
  return {
    method: row.account.method,
    accountHolderName: row.account.accountHolderName,
    accountNumber: row.account.accountNumberEncrypted ? decryptSecret(row.account.accountNumberEncrypted) : null,
    ifsc: row.account.ifsc,
    upiId: row.account.upiIdEncrypted ? decryptSecret(row.account.upiIdEncrypted) : null,
  };
}
