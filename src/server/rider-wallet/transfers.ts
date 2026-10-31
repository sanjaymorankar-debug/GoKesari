/**
 * Rider bank transfers (docs/gig-bank-payouts-2026-10): the money side shared
 * by withdrawals and the monthly payout.
 *
 * A rider's balance is what they have earned and not been paid: their
 * delivery_partner_earnings with no payout yet, plus their PENDING rider
 * adjustments (a negative one — COD cash they hold — lowers it). Paying it
 * reuses the weekly payout record: a rider_payouts row claims those earnings
 * and adjustments (exactly as prepareRiderPayouts does, so nothing is ever
 * paid twice — weekly, withdrawal or monthly), and one rider_bank_transfers
 * row carries the bank transfer.
 *
 * A withdrawal of less than the whole balance claims everything and carries
 * the rest forward as a pair of rider adjustments (−rest on this payout,
 * +rest pending for the next one). Releasing a payout — the bank refused it —
 * hands its earnings and adjustments back exactly as cancelling a weekly
 * batch does; the pair keeps the rider's balance right whether or not the
 * +rest was already paid out since.
 *
 * Order of events, so the rider's money is never debited for a transfer that
 * was not sent: the claim (the "debit", shown as pending) commits first, so a
 * second withdrawal cannot spend the same earnings; then the provider is called
 * outside every transaction (CLAUDE.md: no external call inside db.transaction)
 * with an idempotency key per attempt. A definite refusal of a withdrawal
 * releases the claim at once and tells the rider; a monthly payment is retried
 * rule riderPayouts.maxRetries times, then flagged for finance. When the
 * provider cannot be reached the outcome is unknown, so nothing is retried or
 * released automatically: the transfer waits for finance (Admin → Rider payouts).
 *
 * Every table here is platform (core database) except financial_adjustments
 * (customer, also core): no seller table, so the split layout changes nothing.
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";

import { maskAccountNumber } from "@/lib/bank-accounts";
import { conflict, notFound } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { decryptSecret } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import {
  bankAccounts,
  deliveryPartnerEarnings,
  deliveryPartners,
  financialAdjustments,
  riderBankTransfers,
  riderPayouts,
  riderTransferEvents,
  type BankAccount,
  type RiderBankTransfer,
  type RiderPayout,
  type UserRole,
} from "@/server/db/schema";
import { getPayoutProvider } from "@/server/payouts/providers";
import { buildSandboxWebhook } from "@/server/payouts/providers/sandbox";
import type { PayoutProvider, PayoutWebhookEvent } from "@/server/payouts/types";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { assertNoFailedBankCheck } from "@/server/services/bank-account-check";
import { currentBankAccount } from "@/server/services/bank-accounts";
import { postLedger } from "@/server/services/finance";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { computeTds, financialYearBounds, type TdsResult } from "./rules";

export interface SystemOrActor {
  id: string | null;
  role: UserRole | null;
}

const SYSTEM: SystemOrActor = { id: null, role: null };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/* ================================================================ balance */

export interface RiderBalance {
  earningsPaise: number;
  adjustmentsPaise: number;
  /** What can be paid: earnings + adjustments (may be negative: the rider owes COD cash). */
  availablePaise: number;
  /** Claimed by a payout still on its way to the bank. */
  inFlightPaise: number;
}

/** Earnings and adjustments not yet in any payout; `before` limits them to what was earned before an instant. */
export async function unpaidBalance(deliveryPartnerId: string, before: Date | null = null, client: DbClient = db): Promise<RiderBalance> {
  const [earned] = await client
    .select({ sum: sql<string>`coalesce(sum(${deliveryPartnerEarnings.totalPaise}), 0)` })
    .from(deliveryPartnerEarnings)
    .where(
      and(
        eq(deliveryPartnerEarnings.deliveryPartnerId, deliveryPartnerId),
        isNull(deliveryPartnerEarnings.payoutId),
        before ? lt(deliveryPartnerEarnings.createdAt, before) : undefined,
      ),
    );
  const [adjusted] = await client
    .select({ sum: sql<string>`coalesce(sum(${financialAdjustments.amountPaise}), 0)` })
    .from(financialAdjustments)
    .where(pendingAdjustments(deliveryPartnerId, before));
  const [inFlight] = await client
    .select({ sum: sql<string>`coalesce(sum(${riderBankTransfers.grossPaise}), 0)` })
    .from(riderBankTransfers)
    .where(and(eq(riderBankTransfers.deliveryPartnerId, deliveryPartnerId), inArray(riderBankTransfers.status, ["PENDING", "PROCESSING", "FAILED"])));
  const earningsPaise = Number(earned.sum);
  const adjustmentsPaise = Number(adjusted.sum);
  return { earningsPaise, adjustmentsPaise, availablePaise: earningsPaise + adjustmentsPaise, inFlightPaise: Number(inFlight.sum) };
}

function pendingAdjustments(deliveryPartnerId: string, before: Date | null) {
  return and(
    eq(financialAdjustments.party, "RIDER"),
    eq(financialAdjustments.deliveryPartnerId, deliveryPartnerId),
    eq(financialAdjustments.status, "PENDING"),
    isNull(financialAdjustments.payoutId),
    before ? lt(financialAdjustments.createdAt, before) : undefined,
  );
}

/* ================================================================== claim */

export interface ClaimInput {
  deliveryPartnerId: string;
  userId: string;
  kind: "WITHDRAWAL" | "MONTHLY";
  /** Only what was earned before this instant (monthly: the month's end); null = everything. */
  before: Date | null;
  /** What to pay; null = the whole balance. */
  amountPaise: number | null;
  /** Called with the balance once the rows are locked: throw to refuse (limits, minimum). */
  check: (availablePaise: number) => void;
  feePaise: number;
  account: BankAccount;
  provider: PayoutProvider;
  mode: RiderBankTransfer["mode"];
  runId: string | null;
  periodStart: string;
  periodEnd: string;
  actor: SystemOrActor;
}

/**
 * Inside the caller's transaction (the delivery partner row already locked):
 * claims the rider's unpaid earnings and adjustments into a new payout and
 * creates its PENDING transfer, TDS worked out. Returns null when there is
 * nothing to pay.
 */
export async function claimIntoTransfer(tx: Tx, input: ClaimInput): Promise<{ payout: RiderPayout; transfer: RiderBankTransfer; tds: TdsResult } | null> {
  const earnings = await tx
    .select({ id: deliveryPartnerEarnings.id, totalPaise: deliveryPartnerEarnings.totalPaise, createdAt: deliveryPartnerEarnings.createdAt })
    .from(deliveryPartnerEarnings)
    .where(
      and(
        eq(deliveryPartnerEarnings.deliveryPartnerId, input.deliveryPartnerId),
        isNull(deliveryPartnerEarnings.payoutId),
        input.before ? lt(deliveryPartnerEarnings.createdAt, input.before) : undefined,
      ),
    )
    .for("update");
  const adjustments = await tx
    .select({ id: financialAdjustments.id, amountPaise: financialAdjustments.amountPaise })
    .from(financialAdjustments)
    .where(pendingAdjustments(input.deliveryPartnerId, input.before))
    .for("update");
  const grossEarned = earnings.reduce((sum, e) => sum + e.totalPaise, 0);
  const adjusted = adjustments.reduce((sum, a) => sum + a.amountPaise, 0);
  const available = grossEarned + adjusted;
  input.check(available);
  const amount = input.amountPaise ?? available;
  if (amount <= 0 || amount > available) return null;
  const carry = available - amount;

  const rule = await getRule("riderPayouts");
  const tds = await tdsFor(tx, input.deliveryPartnerId, amount, input.feePaise, rule);

  const now = new Date();
  const [payout] = await tx
    .insert(riderPayouts)
    .values({
      deliveryPartnerId: input.deliveryPartnerId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      earningsCount: earnings.length,
      grossPaise: grossEarned,
      adjustmentsPaise: adjusted - carry,
      amountPaise: amount,
      // Approved by the rider's own request (withdrawal) or the owner-approved monthly rule: straight to the bank.
      status: "PROCESSING",
      approvedAt: now,
      processingAt: now,
      createdBy: input.actor.id,
    })
    .returning();
  if (earnings.length > 0) {
    await tx.update(deliveryPartnerEarnings).set({ payoutId: payout.id }).where(inArray(deliveryPartnerEarnings.id, earnings.map((e) => e.id)));
  }
  if (adjustments.length > 0) {
    await tx
      .update(financialAdjustments)
      .set({ payoutId: payout.id, status: "SETTLED" })
      .where(inArray(financialAdjustments.id, adjustments.map((a) => a.id)));
  }
  if (carry > 0) {
    const reason = `Carried forward from the withdrawal of ${formatPaise(amount)} (payout ${payout.id})`;
    await tx.insert(financialAdjustments).values([
      {
        type: "RIDER_ADJUSTMENT",
        party: "RIDER",
        status: "SETTLED",
        deliveryPartnerId: input.deliveryPartnerId,
        amountPaise: -carry,
        reason,
        payoutId: payout.id,
        idempotencyKey: `rider-carry:${payout.id}:out`,
        createdBy: input.actor.id,
      },
      {
        type: "RIDER_ADJUSTMENT",
        party: "RIDER",
        status: "PENDING",
        deliveryPartnerId: input.deliveryPartnerId,
        amountPaise: carry,
        reason,
        idempotencyKey: `rider-carry:${payout.id}:in`,
        createdBy: input.actor.id,
      },
    ]);
  }
  const [transfer] = await tx
    .insert(riderBankTransfers)
    .values({
      deliveryPartnerId: input.deliveryPartnerId,
      userId: input.userId,
      payoutId: payout.id,
      kind: input.kind,
      runId: input.runId,
      bankAccountId: input.account.id,
      method: input.account.method,
      mode: input.mode,
      provider: input.provider.name,
      grossPaise: amount,
      tdsPaise: tds.tdsPaise,
      tdsRateBp: tds.rateBp,
      feePaise: input.feePaise,
      netPaise: amount - tds.tdsPaise - input.feePaise,
    })
    .returning();
  await recordAudit(
    {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: AUDIT_ACTIONS.RIDER_PAYOUT_PREPARED,
      entityType: "rider_payout",
      entityId: payout.id,
      newValue: { deliveryPartnerId: input.deliveryPartnerId, kind: input.kind, transferId: transfer.id, amountPaise: amount, tdsPaise: tds.tdsPaise, feePaise: input.feePaise, carriedPaise: carry, earnings: earnings.length },
    },
    tx,
  );
  return { payout, transfer, tds };
}

async function tdsFor(
  tx: Tx,
  deliveryPartnerId: string,
  grossPaise: number,
  feePaise: number,
  rule: Awaited<ReturnType<typeof getRule<"riderPayouts">>>,
): Promise<TdsResult> {
  const fy = financialYearBounds(new Date());
  // Weekly batches count too: everything credited to the rider this year that was not cancelled or reversed.
  const [paid] = await tx
    .select({ sum: sql<string>`coalesce(sum(${riderPayouts.amountPaise}), 0)` })
    .from(riderPayouts)
    .where(
      and(
        eq(riderPayouts.deliveryPartnerId, deliveryPartnerId),
        notInArray(riderPayouts.status, ["CANCELLED", "REVERSED"]),
        gte(riderPayouts.createdAt, fy.start),
        lt(riderPayouts.createdAt, fy.end),
      ),
    );
  const [deducted] = await tx
    .select({ sum: sql<string>`coalesce(sum(${riderBankTransfers.tdsPaise}), 0)` })
    .from(riderBankTransfers)
    .where(
      and(
        eq(riderBankTransfers.deliveryPartnerId, deliveryPartnerId),
        notInArray(riderBankTransfers.status, ["RELEASED", "REVERSED"]),
        gte(riderBankTransfers.createdAt, fy.start),
        lt(riderBankTransfers.createdAt, fy.end),
      ),
    );
  const [partner] = await tx.select({ pan: deliveryPartners.panNumberEncrypted }).from(deliveryPartners).where(eq(deliveryPartners.id, deliveryPartnerId));
  return computeTds(rule, {
    grossPaise,
    paidThisYearPaise: Number(paid.sum),
    tdsThisYearPaise: Number(deducted.sum),
    hasPan: Boolean(partner?.pan),
    maxPaise: Math.max(grossPaise - feePaise - 100, 0),
  });
}

/* =============================================================== accounts */

/** The user's personal bank account when it can receive money: current, verified, not refused by the bank check. */
export async function payableAccount(userId: string, client: DbClient = db): Promise<BankAccount | null> {
  const account = await currentBankAccount(userId, null, client);
  if (!account || account.status !== "VERIFIED") return null;
  try {
    await assertNoFailedBankCheck(account);
  } catch {
    return null;
  }
  return account;
}

export function accountLabel(account: Pick<BankAccount, "method" | "accountNumberLast4" | "upiIdMasked" | "ifsc">): string {
  return account.method === "UPI" ? `UPI ID ${account.upiIdMasked}` : `account ${maskAccountNumber(account.accountNumberLast4)} (${account.ifsc})`;
}

export function railFor(account: Pick<BankAccount, "method">, mode: "IMPS" | "NEFT"): RiderBankTransfer["mode"] {
  return account.method === "UPI" ? "UPI" : mode;
}

/** The configured provider, or null when it cannot send (no keys, or the sandbox on gokesari.com). */
export async function activeRiderProvider(): Promise<PayoutProvider | null> {
  const rule = await getRule("riderPayouts");
  const provider = getPayoutProvider(rule.provider);
  return provider && provider.isConfigured() ? provider : null;
}

/* =================================================================== send */

async function logEvent(client: DbClient, input: { transferId: string; source?: string; eventId?: string; type: string; payload?: Record<string, unknown>; actorId?: string | null }) {
  await client
    .insert(riderTransferEvents)
    .values({
      transferId: input.transferId,
      source: input.source ?? "SYSTEM",
      eventId: input.eventId ?? `${input.type}:${input.transferId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      type: input.type,
      payload: input.payload ?? {},
      actorId: input.actorId ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Sends a PENDING transfer (first attempt) or a FAILED one due for a retry.
 * The account paid is the rider's verified account at the time of sending.
 */
export async function sendTransfer(transferId: string, actor: SystemOrActor = SYSTEM): Promise<RiderBankTransfer> {
  const rule = await getRule("riderPayouts");
  const provider = getPayoutProvider(rule.provider);
  const claimed = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, transferId)).for("update");
    if (!t) throw notFound("Transfer");
    if (t.status !== "PENDING" && t.status !== "FAILED") return { transfer: t, account: null, send: false };
    const account = await payableAccount(t.userId, tx);
    if (!provider || !provider.isConfigured() || !account) {
      return { transfer: t, account: null, send: false, refused: !account ? "No verified bank account to pay into." : "Bank transfers are not available right now." };
    }
    const retry = t.status === "FAILED";
    const [updated] = await tx
      .update(riderBankTransfers)
      .set({
        status: "PROCESSING",
        attempts: t.attempts + 1,
        retryCount: retry ? t.retryCount + 1 : t.retryCount,
        provider: provider.name,
        bankAccountId: account.id,
        method: account.method,
        mode: railFor(account, t.kind === "WITHDRAWAL" ? rule.withdrawalMode : rule.monthlyMode),
        nextRetryAt: null,
        needsReview: false,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(riderBankTransfers.id, t.id))
      .returning();
    return { transfer: updated, account, send: true };
  });
  if (!claimed.send || !claimed.account || !provider) {
    if (!("refused" in claimed) || !claimed.refused) return claimed.transfer;
    // Nothing was sent. A first attempt fails as a refusal would; a retry goes to finance instead of looping.
    if (claimed.transfer.status === "PENDING") {
      return applyOutcome(transferId, { status: "FAILED", reason: claimed.refused, definite: true, source: "SYSTEM" }, actor);
    }
    const [held] = await db
      .update(riderBankTransfers)
      .set({ needsReview: true, nextRetryAt: null, failureReason: claimed.refused, updatedAt: new Date() })
      .where(and(eq(riderBankTransfers.id, transferId), eq(riderBankTransfers.status, "FAILED")))
      .returning();
    return held ?? claimed.transfer;
  }
  const t = claimed.transfer;
  const account = claimed.account;
  try {
    const result = await provider.createTransfer({
      idempotencyKey: `rider-transfer:${t.id}:${t.attempts}`,
      referenceId: t.id,
      amountPaise: t.netPaise,
      mode: t.mode,
      beneficiary: {
        name: account.accountHolderName,
        method: account.method,
        accountNumber: account.accountNumberEncrypted ? decryptSecret(account.accountNumberEncrypted) : null,
        ifsc: account.ifsc,
        upiId: account.upiIdEncrypted ? decryptSecret(account.upiIdEncrypted) : null,
      },
      narration: t.kind === "WITHDRAWAL" ? "GoKesari rider withdrawal" : "GoKesari rider monthly payout",
      attempt: t.attempts,
    });
    await db.update(riderBankTransfers).set({ providerRef: result.providerRef, updatedAt: new Date() }).where(eq(riderBankTransfers.id, t.id));
    await logEvent(db, { transferId: t.id, source: provider.name, eventId: `transfer:${result.providerRef}:${t.attempts}`, type: "TRANSFER_CREATED", payload: { status: result.status, attempt: t.attempts, mode: t.mode }, actorId: actor.id });
    if (result.status === "SUCCESS" && result.utr) return applyOutcome(t.id, { status: "SUCCESS", utr: result.utr, source: provider.name }, actor);
    if (result.status === "FAILED") return applyOutcome(t.id, { status: "FAILED", reason: result.failureReason ?? "Rejected by the bank.", definite: true, source: provider.name }, actor);
    if (provider.name === "SANDBOX" && rule.sandboxAutoWebhook) await deliverSandboxWebhook(t.id);
  } catch (error) {
    // The request may or may not have reached the bank: never retry or release blind.
    const reason = error instanceof Error ? error.message : "The payout provider could not be reached.";
    return applyOutcome(t.id, { status: "FAILED", reason: `Outcome unknown — ${reason}`, definite: false, source: provider.name }, actor);
  }
  const [after] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, t.id));
  return after;
}

/** The sandbox "bank" answers through the same signed webhook path a real provider uses. */
async function deliverSandboxWebhook(transferId: string): Promise<void> {
  const [t] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, transferId));
  if (!t?.providerRef || t.status !== "PROCESSING") return;
  const { rawBody, headers } = buildSandboxWebhook(t.providerRef, { referenceId: t.id, amountPaise: t.netPaise, attempt: t.attempts });
  const { handlePayoutWebhook } = await import("@/server/payouts/batches");
  await handlePayoutWebhook("sandbox", rawBody, headers);
}

/* ================================================================ outcome */

type Outcome =
  | { status: "SUCCESS"; utr: string; source: string }
  | { status: "FAILED"; reason: string; definite: boolean; source: string }
  | { status: "REVERSED"; reason: string; source: string };

interface Notice {
  type: (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];
  vars: Record<string, string>;
  dedupeKey: string;
}

/** Releases a payout's claim: its earnings and adjustments are unpaid again (as cancelling a weekly batch does). */
async function releasePayout(tx: Tx, payoutId: string, status: "CANCELLED" | "REVERSED", reason: string): Promise<void> {
  const now = new Date();
  await tx
    .update(riderPayouts)
    .set({ status, failureReason: reason, ...(status === "REVERSED" ? { reversedAt: now } : { failedAt: now }), updatedAt: now })
    .where(eq(riderPayouts.id, payoutId));
  await tx.update(deliveryPartnerEarnings).set({ payoutId: null }).where(eq(deliveryPartnerEarnings.payoutId, payoutId));
  await tx.update(financialAdjustments).set({ payoutId: null, status: "PENDING" }).where(eq(financialAdjustments.payoutId, payoutId));
}

function what(t: Pick<RiderBankTransfer, "kind">): string {
  return t.kind === "WITHDRAWAL" ? "Your withdrawal" : "Your monthly payout";
}

/** Applies a provider's (or our own) answer. Safe to call twice with the same answer. */
export async function applyOutcome(transferId: string, outcome: Outcome, actor: SystemOrActor = SYSTEM): Promise<RiderBankTransfer> {
  const rule = await getRule("riderPayouts");
  const notices: Notice[] = [];
  const updated = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, transferId)).for("update");
    if (!t) throw notFound("Transfer");
    const [account] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, t.bankAccountId));
    const label = account ? accountLabel(account) : "your bank account";
    const now = new Date();
    let next: Partial<RiderBankTransfer> | null = null;

    if (outcome.status === "SUCCESS") {
      if (t.status === "SUCCESS" || t.status === "REVERSED") return t;
      if (t.status === "RELEASED") {
        // Paid after we handed the money back: finance must recover it. Never pay twice silently.
        next = { needsReview: true, utr: outcome.utr, failureReason: `The bank paid this transfer after it was released (UTR ${outcome.utr}). Recover the amount from the rider's balance.` };
      } else {
        next = { status: "SUCCESS", utr: outcome.utr, failureReason: null, needsReview: false, nextRetryAt: null, completedAt: now };
        await tx
          .update(riderPayouts)
          .set({ status: "PAID", paidAt: now, paymentReference: outcome.utr, failureReason: null, updatedAt: now })
          .where(eq(riderPayouts.id, t.payoutId));
        await postLedger(
          [{ sourceType: "rider_payouts", sourceId: t.payoutId, entityType: "RIDER", entityId: t.deliveryPartnerId, entryType: "RIDER_PAYOUT", direction: "DEBIT", amountPaise: t.grossPaise, reference: outcome.utr, key: `payout:${t.payoutId}:paid` }],
          actor.id,
          tx,
        );
        notices.push({
          type: NOTIFICATION_TYPES.RIDER_PAYOUT_PAID,
          dedupeKey: `rider-transfer:${t.id}:paid`,
          vars: { what: what(t), gross: formatPaise(t.grossPaise), tds: formatPaise(t.tdsPaise), fee: formatPaise(t.feePaise), amount: formatPaise(t.netPaise), account: label, utr: outcome.utr },
        });
      }
    } else if (outcome.status === "REVERSED") {
      if (t.status !== "SUCCESS") return t;
      next = { status: "REVERSED", needsReview: true, failureReason: outcome.reason, completedAt: now };
      await releasePayout(tx, t.payoutId, "REVERSED", outcome.reason);
      await postLedger(
        [{ sourceType: "rider_payouts", sourceId: t.payoutId, entityType: "RIDER", entityId: t.deliveryPartnerId, entryType: "REVERSAL", direction: "CREDIT", amountPaise: t.grossPaise, reference: t.utr, key: `payout:${t.payoutId}:reversed` }],
        actor.id,
        tx,
      );
      notices.push({
        type: NOTIFICATION_TYPES.RIDER_PAYOUT_FAILED,
        dedupeKey: `rider-transfer:${t.id}:reversed`,
        vars: { what: what(t), amount: formatPaise(t.netPaise), account: label, reason: outcome.reason, next: "The amount is back in your balance. Check your bank details under My wallet, then withdraw again." },
      });
    } else {
      if (t.status !== "PROCESSING" && t.status !== "PENDING") return t;
      if (!outcome.definite) {
        next = { status: "FAILED", needsReview: true, failureReason: outcome.reason, nextRetryAt: null };
        notices.push({
          type: NOTIFICATION_TYPES.RIDER_PAYOUT_FAILED,
          dedupeKey: `rider-transfer:${t.id}:unknown:${t.attempts}`,
          vars: { what: what(t), amount: formatPaise(t.netPaise), account: label, reason: "we could not confirm it with the bank.", next: "Our finance team is checking it; you'll hear from us. Nothing is lost." },
        });
      } else if (t.kind === "WITHDRAWAL") {
        next = { status: "RELEASED", failureReason: outcome.reason, nextRetryAt: null, completedAt: now };
        await releasePayout(tx, t.payoutId, "CANCELLED", outcome.reason);
        notices.push({
          type: NOTIFICATION_TYPES.RIDER_PAYOUT_FAILED,
          dedupeKey: `rider-transfer:${t.id}:released`,
          vars: { what: what(t), amount: formatPaise(t.netPaise), account: label, reason: outcome.reason, next: "The amount is back in your balance — you can withdraw it again." },
        });
      } else if (t.retryCount < rule.maxRetries) {
        next = { status: "FAILED", failureReason: outcome.reason, nextRetryAt: new Date(now.getTime() + rule.retryBackoffMinutes * (t.retryCount + 1) * 60_000) };
        await tx.update(riderPayouts).set({ status: "FAILED", failedAt: now, failureReason: outcome.reason, updatedAt: now }).where(eq(riderPayouts.id, t.payoutId));
      } else {
        next = { status: "FAILED", needsReview: true, failureReason: outcome.reason, nextRetryAt: null };
        await tx.update(riderPayouts).set({ status: "FAILED", failedAt: now, failureReason: outcome.reason, updatedAt: now }).where(eq(riderPayouts.id, t.payoutId));
        notices.push({
          type: NOTIFICATION_TYPES.RIDER_PAYOUT_FAILED,
          dedupeKey: `rider-transfer:${t.id}:review`,
          vars: { what: what(t), amount: formatPaise(t.netPaise), account: label, reason: outcome.reason, next: "Our finance team will retry it or return it to your balance. Check your bank details under My wallet." },
        });
      }
    }
    const [row] = await tx.update(riderBankTransfers).set({ ...next, updatedAt: now }).where(eq(riderBankTransfers.id, t.id)).returning();
    await logEvent(tx, { transferId: t.id, source: outcome.source, type: `OUTCOME_${outcome.status}`, payload: { from: t.status, to: row.status, reason: "reason" in outcome ? outcome.reason : null, utr: "utr" in outcome ? outcome.utr : null }, actorId: actor.id });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_TRANSFER_STATUS_CHANGED,
        entityType: "rider_bank_transfer",
        entityId: t.id,
        previousValue: { status: t.status },
        newValue: { status: row.status, needsReview: row.needsReview, retryCount: row.retryCount, reason: row.failureReason, utr: row.utr },
      },
      tx,
    );
    return row;
  });
  // After the commit: a notification never decides the money.
  for (const n of notices) {
    await notify({ userId: updated.userId, type: n.type, vars: n.vars, dedupeKey: n.dedupeKey, actionUrl: `/gig/wallet/payouts/${updated.id}` });
  }
  return updated;
}

/* ================================================================ webhooks */

/**
 * A payout webhook that matched no shop payout item (handlePayoutWebhook,
 * after the signature check and the once-per-event guard): a rider transfer?
 */
export async function handleRiderTransferEvent(source: string, event: PayoutWebhookEvent): Promise<{ status: number; body: Record<string, unknown> }> {
  let transfer: RiderBankTransfer | undefined;
  if (event.providerRef) [transfer] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.providerRef, event.providerRef));
  if (!transfer && event.referenceId && /^[0-9a-f-]{36}$/i.test(event.referenceId)) {
    [transfer] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, event.referenceId));
  }
  if (!transfer) return { status: 200, body: { ok: true, ignored: "No payout matches this event." } };
  await logEvent(db, { transferId: transfer.id, source, eventId: event.eventId, type: `WEBHOOK_${event.status}`, payload: event.raw });
  if (event.status === "SUCCESS") {
    if (!event.utr) return { status: 200, body: { ok: true, pending: "Success without a UTR — waiting for the bank reference." } };
    await applyOutcome(transfer.id, { status: "SUCCESS", utr: event.utr.toUpperCase(), source });
  } else if (event.status === "FAILED") {
    await applyOutcome(transfer.id, { status: "FAILED", reason: event.failureReason ?? "The bank rejected the transfer.", definite: true, source });
  } else if (event.status === "REVERSED") {
    await applyOutcome(transfer.id, { status: "REVERSED", reason: event.failureReason ?? "The bank returned the transfer.", source });
  }
  return { status: 200, body: { ok: true } };
}

/* ================================================================= retries */

/**
 * Hourly: monthly transfers whose backoff has passed, and transfers created but
 * never sent (the process stopped between the commit and the provider call).
 */
export async function retryDueTransfers(now: Date = new Date()): Promise<{ retried: number; resent: number }> {
  const due = await db
    .select({ id: riderBankTransfers.id, status: riderBankTransfers.status })
    .from(riderBankTransfers)
    .where(
      or(
        and(eq(riderBankTransfers.status, "FAILED"), eq(riderBankTransfers.needsReview, false), lte(riderBankTransfers.nextRetryAt, now)),
        and(eq(riderBankTransfers.status, "PENDING"), lt(riderBankTransfers.createdAt, new Date(now.getTime() - 5 * 60_000))),
      ),
    )
    .orderBy(asc(riderBankTransfers.createdAt))
    .limit(200);
  let retried = 0;
  let resent = 0;
  for (const row of due) {
    await sendTransfer(row.id, SYSTEM);
    if (row.status === "FAILED") retried += 1;
    else resent += 1;
  }
  return { retried, resent };
}

/* ============================================================ finance steps */

/**
 * Finance on a transfer waiting for review: "retry" sends it again (a new
 * attempt), "release" hands the amount back to the rider's balance. FINANCE_PREPARE.
 */
export async function reviewTransfer(transferId: string, action: "retry" | "release", actor: { id: string; role: UserRole }, note?: string): Promise<RiderBankTransfer> {
  if (action === "retry") {
    const [t] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, transferId));
    if (!t) throw notFound("Transfer");
    if (t.status !== "FAILED") throw conflict(`A ${t.status.toLowerCase()} transfer cannot be retried.`);
    await db.update(riderBankTransfers).set({ needsReview: false, nextRetryAt: null, updatedAt: new Date() }).where(eq(riderBankTransfers.id, t.id));
    await logEvent(db, { transferId: t.id, type: "REVIEW_RETRY", payload: { note: note ?? null }, actorId: actor.id });
    return sendTransfer(t.id, actor);
  }
  const notices: Notice[] = [];
  const row = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, transferId)).for("update");
    if (!t) throw notFound("Transfer");
    if (t.status !== "FAILED" && t.status !== "PENDING") throw conflict(`A ${t.status.toLowerCase()} transfer cannot be released.`);
    const reason = note?.trim() || t.failureReason || "Released by finance.";
    await releasePayout(tx, t.payoutId, "CANCELLED", reason);
    const [updated] = await tx
      .update(riderBankTransfers)
      .set({ status: "RELEASED", needsReview: false, nextRetryAt: null, failureReason: reason, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(riderBankTransfers.id, t.id))
      .returning();
    await logEvent(tx, { transferId: t.id, type: "REVIEW_RELEASE", payload: { note: note ?? null }, actorId: actor.id });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.RIDER_TRANSFER_STATUS_CHANGED, entityType: "rider_bank_transfer", entityId: t.id, previousValue: { status: t.status }, newValue: { status: "RELEASED", reason } },
      tx,
    );
    notices.push({
      type: NOTIFICATION_TYPES.RIDER_PAYOUT_FAILED,
      dedupeKey: `rider-transfer:${t.id}:released`,
      vars: { what: what(t), amount: formatPaise(t.netPaise), account: "your bank account", reason, next: "The amount is back in your balance — you can withdraw it again." },
    });
    return updated;
  });
  for (const n of notices) await notify({ userId: row.userId, type: n.type, vars: n.vars, dedupeKey: n.dedupeKey, actionUrl: "/gig/wallet" });
  return row;
}
