/**
 * What the rider and finance see (docs/gig-bank-payouts-2026-10). Account
 * numbers appear masked only (last 4 digits); nothing here decrypts them.
 */
import { and, desc, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { bankAccounts, deliveryPartners, riderBankTransfers, riderPayouts, riderTransferEvents, type RiderBankTransfer } from "@/server/db/schema";
import { getBankAccountView, type BankAccountView } from "@/server/services/bank-accounts";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { computeTds, financialYearBounds, withdrawalProblem } from "./rules";
import { accountLabel, activeRiderProvider, unpaidBalance, type RiderBalance } from "./transfers";
import { kycComplete, riderOf, withdrawnTodayPaise } from "./withdrawals";

export interface TransferView {
  id: string;
  kind: RiderBankTransfer["kind"];
  status: RiderBankTransfer["status"];
  grossPaise: number;
  tdsPaise: number;
  tdsRateBp: number;
  feePaise: number;
  netPaise: number;
  mode: RiderBankTransfer["mode"];
  account: string;
  utr: string | null;
  failureReason: string | null;
  retryCount: number;
  needsReview: boolean;
  createdAt: string;
  completedAt: string | null;
}

async function toViews(rows: RiderBankTransfer[]): Promise<TransferView[]> {
  const ids = [...new Set(rows.map((r) => r.bankAccountId))];
  const accounts = ids.length ? await db.select().from(bankAccounts).where(inArray(bankAccounts.id, ids)) : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return rows.map((t) => {
    const account = byId.get(t.bankAccountId);
    return {
      id: t.id,
      kind: t.kind,
      status: t.status,
      grossPaise: t.grossPaise,
      tdsPaise: t.tdsPaise,
      tdsRateBp: t.tdsRateBp,
      feePaise: t.feePaise,
      netPaise: t.netPaise,
      mode: t.mode,
      account: account ? accountLabel(account) : "bank account",
      utr: t.utr,
      failureReason: t.failureReason,
      retryCount: t.retryCount,
      needsReview: t.needsReview,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
    };
  });
}

export interface RiderWalletView {
  flags: { bankAccount: boolean; withdrawal: boolean; monthly: boolean };
  partner: { id: string; name: string; approved: boolean } | null;
  balance: RiderBalance | null;
  account: BankAccountView | null;
  limits: { minPaise: number; maxPaise: number; dailyMaxPaise: number; leftTodayPaise: number; feePaise: number; settlement: string };
  monthly: { day: number; hourIst: number; minPaise: number; settlement: string };
  available: boolean;
  transfers: TransferView[];
  /** Weekly payouts finance pays by hand, for the history. */
  weekly: { id: string; periodStart: string; periodEnd: string; amountPaise: number; status: string; reference: string | null }[];
}

export async function getRiderWallet(userId: string): Promise<RiderWalletView> {
  const [bankAccount, withdrawal, monthlyOn] = await Promise.all([
    isFeatureEnabled("rider_bank_account_enabled"),
    isFeatureEnabled("rider_withdrawal_enabled"),
    isFeatureEnabled("rider_monthly_payout_enabled"),
  ]);
  const rule = await getRule("riderPayouts");
  const partner = await riderOf(userId);
  const balance = partner ? await unpaidBalance(partner.id) : null;
  const today = partner ? await withdrawnTodayPaise(partner.id) : 0;
  const rows = partner
    ? await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.deliveryPartnerId, partner.id)).orderBy(desc(riderBankTransfers.createdAt)).limit(50)
    : [];
  const transferPayoutIds = new Set(rows.map((r) => r.payoutId));
  const weekly = partner
    ? (await db.select().from(riderPayouts).where(eq(riderPayouts.deliveryPartnerId, partner.id)).orderBy(desc(riderPayouts.createdAt)).limit(50))
        .filter((p) => !transferPayoutIds.has(p.id) && p.status !== "CANCELLED")
        .map((p) => ({ id: p.id, periodStart: p.periodStart, periodEnd: p.periodEnd, amountPaise: p.amountPaise, status: p.status, reference: p.paymentReference }))
    : [];
  return {
    flags: { bankAccount, withdrawal, monthly: monthlyOn },
    partner: partner ? { id: partner.id, name: partner.fullName, approved: kycComplete(partner) } : null,
    balance,
    account: await getBankAccountView(userId, null),
    limits: {
      minPaise: rule.withdrawalMinPaise,
      maxPaise: rule.withdrawalMaxPaise,
      dailyMaxPaise: rule.withdrawalDailyMaxPaise,
      leftTodayPaise: Math.max(rule.withdrawalDailyMaxPaise - today, 0),
      feePaise: rule.withdrawalFeePaise,
      settlement: rule.withdrawalSettlement,
    },
    monthly: { day: rule.payoutDayOfMonth, hourIst: rule.payoutHourIst, minPaise: rule.monthlyMinPaise, settlement: rule.monthlySettlement },
    available: Boolean(await activeRiderProvider()),
    transfers: await toViews(rows),
    weekly,
  };
}

export interface WithdrawalQuote {
  amountPaise: number;
  feePaise: number;
  tdsPaise: number;
  tdsRateBp: number;
  netPaise: number;
  settlement: string;
  account: string | null;
  problem: string | null;
}

/** What a withdrawal of `amountPaise` would pay, shown before the rider confirms. Reads only. */
export async function quoteWithdrawal(userId: string, amountPaise: number): Promise<WithdrawalQuote> {
  const rule = await getRule("riderPayouts");
  const partner = await riderOf(userId);
  if (!partner) throw notFound("Delivery partner");
  const balance = await unpaidBalance(partner.id);
  const problem = withdrawalProblem(rule, { amountPaise, availablePaise: balance.availablePaise, withdrawnTodayPaise: await withdrawnTodayPaise(partner.id) });
  const fy = financialYearBounds(new Date());
  const [paid] = await db
    .select({ sum: sql<string>`coalesce(sum(${riderPayouts.amountPaise}), 0)` })
    .from(riderPayouts)
    .where(and(eq(riderPayouts.deliveryPartnerId, partner.id), notInArray(riderPayouts.status, ["CANCELLED", "REVERSED"]), gte(riderPayouts.createdAt, fy.start), lt(riderPayouts.createdAt, fy.end)));
  const [deducted] = await db
    .select({ sum: sql<string>`coalesce(sum(${riderBankTransfers.tdsPaise}), 0)` })
    .from(riderBankTransfers)
    .where(and(eq(riderBankTransfers.deliveryPartnerId, partner.id), notInArray(riderBankTransfers.status, ["RELEASED", "REVERSED"]), gte(riderBankTransfers.createdAt, fy.start), lt(riderBankTransfers.createdAt, fy.end)));
  const amount = Number.isInteger(amountPaise) && amountPaise > 0 ? amountPaise : 0;
  const tds = computeTds(rule, {
    grossPaise: amount,
    paidThisYearPaise: Number(paid.sum),
    tdsThisYearPaise: Number(deducted.sum),
    hasPan: Boolean(partner.panNumberEncrypted),
    maxPaise: Math.max(amount - rule.withdrawalFeePaise - 100, 0),
  });
  const account = await getBankAccountView(userId, null);
  return {
    amountPaise: amount,
    feePaise: rule.withdrawalFeePaise,
    tdsPaise: tds.tdsPaise,
    tdsRateBp: tds.rateBp,
    netPaise: Math.max(amount - tds.tdsPaise - rule.withdrawalFeePaise, 0),
    settlement: rule.withdrawalSettlement,
    account: account ? (account.method === "UPI" ? `UPI ID ${account.upiIdMasked}` : `account ${account.accountNumberMasked} (${account.ifsc})`) : null,
    problem,
  };
}

/** One payment's statement for the rider who received it (or finance: `userId` null). */
export async function getTransferStatement(transferId: string, userId: string | null) {
  const [row] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, transferId));
  if (!row || (userId && row.userId !== userId)) throw notFound("Payment");
  const [view] = await toViews([row]);
  const [payout] = await db.select().from(riderPayouts).where(eq(riderPayouts.id, row.payoutId));
  const [partner] = await db.select({ name: deliveryPartners.fullName }).from(deliveryPartners).where(eq(deliveryPartners.id, row.deliveryPartnerId));
  const events = await db
    .select({ type: riderTransferEvents.type, source: riderTransferEvents.source, createdAt: riderTransferEvents.createdAt })
    .from(riderTransferEvents)
    .where(eq(riderTransferEvents.transferId, row.id))
    .orderBy(riderTransferEvents.createdAt);
  return {
    transfer: view,
    partnerName: partner?.name ?? "",
    payout: payout
      ? { periodStart: payout.periodStart, periodEnd: payout.periodEnd, earningsCount: payout.earningsCount, earningsPaise: payout.grossPaise, adjustmentsPaise: payout.adjustmentsPaise }
      : null,
    events: events.map((e) => ({ type: e.type, source: e.source, at: e.createdAt.toISOString() })),
  };
}

/** Finance: transfers that need a decision (retries used up, unknown outcome, reversed, paid after release). */
export async function listTransfersForReview() {
  const rows = await db
    .select({ transfer: riderBankTransfers, partnerName: deliveryPartners.fullName })
    .from(riderBankTransfers)
    .innerJoin(deliveryPartners, eq(riderBankTransfers.deliveryPartnerId, deliveryPartners.id))
    .where(eq(riderBankTransfers.needsReview, true))
    .orderBy(desc(riderBankTransfers.updatedAt))
    .limit(200);
  const views = await toViews(rows.map((r) => r.transfer));
  return views.map((v, i) => ({ ...v, partnerName: rows[i].partnerName }));
}

export async function listRecentWithdrawals(limit = 100) {
  const rows = await db
    .select({ transfer: riderBankTransfers, partnerName: deliveryPartners.fullName })
    .from(riderBankTransfers)
    .innerJoin(deliveryPartners, eq(riderBankTransfers.deliveryPartnerId, deliveryPartners.id))
    .where(eq(riderBankTransfers.kind, "WITHDRAWAL"))
    .orderBy(desc(riderBankTransfers.createdAt))
    .limit(limit);
  const views = await toViews(rows.map((r) => r.transfer));
  return views.map((v, i) => ({ ...v, partnerName: rows[i].partnerName }));
}

export async function runTransferViews(rows: { transfer: RiderBankTransfer; partnerName: string }[]) {
  const views = await toViews(rows.map((r) => r.transfer));
  return views.map((v, i) => ({ ...v, partnerName: rows[i].partnerName }));
}
