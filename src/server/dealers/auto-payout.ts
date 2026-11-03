/**
 * Automatic bank transfer of dealer commission payouts (gap report C4; rule
 * dealerAutoPayout, off). Built on the shop payout providers, the way rider
 * transfers are (src/server/rider-wallet/transfers.ts):
 *
 *   DRAFT ──approve (an admin other than the drafter)──► APPROVED
 *   APPROVED ──send──► PROCESSING ──signed webhook──► PAID (UTR) | FAILED
 *   FAILED ──retry (maxRetries, backoff)──► PROCESSING …  then needs_review for finance
 *
 * The transfer is the net (gross − TDS) to the payee's verified bank account
 * (the dealer's, or the team member's) read at the time of sending. Paying by
 * hand (markPayoutPaid with the bank reference) stays available from DRAFT,
 * APPROVED and FAILED; a payout with the bank (PROCESSING) waits for its answer.
 * The SANDBOX provider never runs on gokesari.com (the adapter refuses there).
 * Every step is audited; the payee is told when it is paid or fails.
 */
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

import { conflict, forbidden, notFound } from "@/lib/errors";
import { decryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { dealerCommissionLedger, dealerPayoutBatches, dealerSalespeople, dealers, type DealerPayoutBatch, type UserRole } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { getPayoutProvider } from "@/server/payouts/providers";
import { buildSandboxWebhook } from "@/server/payouts/providers/sandbox";
import type { PayoutWebhookEvent } from "@/server/payouts/types";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { tdsBlock } from "@/server/tax/commission-tds";
import { OUTCOME_UNKNOWN, markPayoutPaid, payeeStatus, payoutOutcomeUnknown } from "./commission";

interface Actor {
  id: string;
  role: UserRole;
}
const SYSTEM = { id: null as string | null, role: null as UserRole | null };

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const net = (b: Pick<DealerPayoutBatch, "totalPaise" | "tdsPaise">) => b.totalPaise - b.tdsPaise;

interface Beneficiary {
  name: string;
  accountNumber: string;
  ifsc: string;
  userId: string | null;
}

/** The payee's verified bank account now (the dealer's or the member's), or null. */
async function beneficiaryFor(b: Pick<DealerPayoutBatch, "dealerId" | "memberId">): Promise<Beneficiary | null> {
  if (b.memberId) {
    const [m] = await db.select().from(dealerSalespeople).where(eq(dealerSalespeople.id, b.memberId));
    if (!m || m.bankStatus !== "VERIFIED" || !m.bankAccountEnc || !m.bankIfsc) return null;
    return { name: m.bankHolderName ?? m.name, accountNumber: decryptSecret(m.bankAccountEnc), ifsc: m.bankIfsc, userId: m.userId };
  }
  const [d] = await db.select().from(dealers).where(eq(dealers.id, b.dealerId));
  if (!d || d.bankStatus !== "VERIFIED" || !d.bankAccountEnc || !d.bankIfsc) return null;
  return { name: d.bankHolderName ?? d.legalName, accountNumber: decryptSecret(d.bankAccountEnc), ifsc: d.bankIfsc, userId: d.userId };
}

async function payeeUser(b: Pick<DealerPayoutBatch, "dealerId" | "memberId">): Promise<string | null> {
  const [row] = b.memberId
    ? await db.select({ userId: dealerSalespeople.userId }).from(dealerSalespeople).where(eq(dealerSalespeople.id, b.memberId))
    : await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, b.dealerId));
  return row?.userId ?? null;
}

/**
 * ADMIN only (maker-checker): approves a DRAFT payout drafted by someone else
 * (the monthly job counts as the drafter). With rule dealerAutoPayout on, it
 * is sent to the bank at once.
 */
export async function approvePayoutBatch(batchId: string, actor: Actor): Promise<DealerPayoutBatch> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can approve payouts.");
  const approved = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId)).for("update");
    if (!b) throw notFound("Payout");
    if (b.status !== "DRAFT") throw conflict("Only a draft payout can be approved.");
    if (b.createdBy === actor.id) throw conflict("The admin who drafted this payout cannot approve it — another admin approves (maker-checker).");
    const status = await payeeStatus(tx, b.dealerId, b.memberId);
    // An automatic transfer needs the verified account in any case; paying by hand follows rule dealerPayouts.
    if (status.missing.length && (b.memberId || (await getRule("dealerPayouts")).enforcePayeeChecks || (await getRule("dealerAutoPayout")).enabled)) throw conflict(`Cannot be approved yet: ${status.missing.join(", ")} missing.`, { reason: "PAYEE_NOT_READY" });
    const blocked = tdsBlock(b);
    if (blocked) throw conflict(`${blocked} An admin can override it with a reason.`, { reason: "TDS_UNCONFIRMED" });
    const [row] = await tx
      .update(dealerPayoutBatches)
      .set({ status: "APPROVED", approvedBy: actor.id, approvedAt: new Date() })
      .where(eq(dealerPayoutBatches.id, batchId))
      .returning();
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batchId, previousValue: { status: "DRAFT" }, newValue: { status: "APPROVED", netPaise: net(row) } }, tx);
    return row;
  });
  if ((await getRule("dealerAutoPayout")).enabled) return sendDealerPayout(batchId, actor);
  return approved;
}

/**
 * Sends an APPROVED payout (or a FAILED one due for a retry) to the payout
 * provider. Nothing is sent while the rule is off or the provider is not
 * configured; the payout simply stays where it is for an admin to pay by hand.
 */
export async function sendDealerPayout(batchId: string, actor: Actor | typeof SYSTEM = SYSTEM): Promise<DealerPayoutBatch> {
  const rule = await getRule("dealerAutoPayout");
  const provider = getPayoutProvider(rule.provider);
  const [current] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId));
  if (!current) throw notFound("Payout");
  if (!rule.enabled || !provider || !provider.isConfigured()) return current;
  const beneficiary = await beneficiaryFor(current);
  if (!beneficiary) {
    const [held] = await db
      .update(dealerPayoutBatches)
      .set({ needsReview: true, failureReason: "No verified bank account to pay into.", nextRetryAt: null })
      .where(eq(dealerPayoutBatches.id, batchId))
      .returning();
    return held;
  }
  const [claimed] = await db
    .update(dealerPayoutBatches)
    // A new attempt forgets the last attempt's reference: a late event for that attempt matches nothing.
    .set({ status: "PROCESSING", attempts: current.attempts + 1, provider: provider.name, providerRef: null, nextRetryAt: null, needsReview: false, failureReason: null })
    .where(and(eq(dealerPayoutBatches.id, batchId), inArray(dealerPayoutBatches.status, ["APPROVED", "FAILED"])))
    .returning();
  if (!claimed) return current;
  try {
    const result = await provider.createTransfer({
      idempotencyKey: `dealer-payout:${claimed.id}:${claimed.attempts}`,
      referenceId: claimed.id,
      amountPaise: net(claimed),
      mode: rule.mode,
      beneficiary: { name: beneficiary.name, method: "BANK_ACCOUNT", accountNumber: beneficiary.accountNumber, ifsc: beneficiary.ifsc },
      narration: `GoKesari commission ${claimed.periodMonth ?? ""}`.trim(),
      attempt: claimed.attempts,
    });
    await db.update(dealerPayoutBatches).set({ providerRef: result.providerRef }).where(eq(dealerPayoutBatches.id, claimed.id));
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: claimed.id, newValue: { status: "PROCESSING", provider: provider.name, providerRef: result.providerRef, attempt: claimed.attempts, netPaise: net(claimed) } });
    if (result.status === "SUCCESS" && result.utr) return applyDealerPayoutOutcome(claimed.id, { status: "SUCCESS", utr: result.utr });
    if (result.status === "FAILED") return applyDealerPayoutOutcome(claimed.id, { status: "FAILED", reason: result.failureReason ?? "Rejected by the bank." });
    if (provider.name === "SANDBOX" && rule.sandboxAutoWebhook) {
      const { rawBody, headers } = buildSandboxWebhook(result.providerRef, { referenceId: claimed.id, amountPaise: net(claimed), attempt: claimed.attempts });
      const { handlePayoutWebhook } = await import("@/server/payouts/batches");
      await handlePayoutWebhook("sandbox", rawBody, headers);
    }
  } catch (error) {
    // The request may or may not have reached the bank: never retry blind — finance checks.
    const reason = error instanceof Error ? error.message : "The payout provider could not be reached.";
    return applyDealerPayoutOutcome(claimed.id, { status: "FAILED", reason: `${OUTCOME_UNKNOWN} — ${reason}`, review: true });
  }
  const [after] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, claimed.id));
  return after;
}

type Outcome = { status: "SUCCESS"; utr: string } | { status: "FAILED"; reason: string; review?: boolean } | { status: "REVERSED"; reason: string };

/** The bank's answer. Safe to call twice with the same answer. */
export async function applyDealerPayoutOutcome(batchId: string, outcome: Outcome): Promise<DealerPayoutBatch> {
  const rule = await getRule("dealerAutoPayout");
  const [b] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId));
  if (!b) throw notFound("Payout");
  if (outcome.status === "SUCCESS") {
    if (b.status === "PAID") return b;
    // The same path as paying by hand: reconciled, entries PAID, the payee told (with the net and the UTR).
    return markPayoutPaid(batchId, outcome.utr.toUpperCase(), { id: b.approvedBy ?? b.createdBy ?? "00000000-0000-0000-0000-000000000000", role: "ADMIN" }, { viaProvider: true });
  }
  const now = new Date();
  if (outcome.status === "REVERSED" && b.status === "PAID") {
    // The bank returned money already marked paid: the entries are unpaid again and finance looks at it.
    await db.transaction(async (tx) => {
      await tx.update(dealerCommissionLedger).set({ status: "APPROVED", updatedAt: now }).where(and(eq(dealerCommissionLedger.payoutBatchId, batchId), eq(dealerCommissionLedger.status, "PAID")));
      await tx.update(dealerPayoutBatches).set({ status: "FAILED", needsReview: true, failureReason: outcome.reason, paidAt: null }).where(eq(dealerPayoutBatches.id, batchId));
      await recordAudit({ action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batchId, previousValue: { status: "PAID" }, newValue: { status: "FAILED", reversed: true, reason: outcome.reason } }, tx);
    });
  } else if (b.status === "PROCESSING" || b.status === "APPROVED") {
    const review = ("review" in outcome && outcome.review) || outcome.status === "REVERSED" || b.attempts > rule.maxRetries;
    await db
      .update(dealerPayoutBatches)
      .set({ status: "FAILED", failureReason: outcome.reason, needsReview: review, nextRetryAt: review ? null : new Date(now.getTime() + rule.retryBackoffMinutes * b.attempts * 60_000) })
      .where(eq(dealerPayoutBatches.id, batchId));
    await recordAudit({ action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batchId, previousValue: { status: b.status }, newValue: { status: "FAILED", reason: outcome.reason, needsReview: review, attempt: b.attempts } });
  } else {
    return b;
  }
  const [after] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId));
  const userId = await payeeUser(after);
  if (userId) {
    await notify({
      userId,
      type: NOTIFICATION_TYPES.DEALER_PAYOUT_FAILED,
      vars: { amount: rupees(net(after)), reason: outcome.reason, next: after.needsReview ? "GoKesari's finance team will contact you." : "It is tried again automatically." },
      actionUrl: "/dealer",
      channels: ["PUSH"],
      dedupeKey: `dealer-payout-failed:${batchId}:${after.attempts}`,
    });
  }
  return after;
}

/** The payout providers' signed webhook for a dealer payout (after shop payouts and rider transfers). */
export async function handleDealerPayoutEvent(source: string, event: PayoutWebhookEvent): Promise<{ status: number; body: Record<string, unknown> }> {
  let batch: DealerPayoutBatch | undefined;
  if (event.providerRef) [batch] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.providerRef, event.providerRef));
  if (!batch && event.referenceId && /^[0-9a-f-]{36}$/i.test(event.referenceId)) {
    // By our id only while we do not know the attempt's reference: an event of an earlier attempt
    // must never decide a later one (each attempt's reference replaces the last).
    const [byId] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, event.referenceId));
    if (byId && !byId.providerRef) {
      if (byId.status === "PROCESSING") return { status: 409, body: { ok: false, retry: "The transfer is still being sent — deliver this event again later." } };
      if (payoutOutcomeUnknown(byId)) {
        // The bank's answer for the attempt whose outcome we did not know.
        if (event.providerRef) await db.update(dealerPayoutBatches).set({ providerRef: event.providerRef }).where(eq(dealerPayoutBatches.id, byId.id));
        batch = byId;
      }
    }
  }
  if (!batch) return { status: 200, body: { ok: true, ignored: "No payout matches this event." } };
  if (event.status === "SUCCESS") {
    if (!event.utr) return { status: 200, body: { ok: true, pending: "Success without a UTR — waiting for the bank reference." } };
    await applyDealerPayoutOutcome(batch.id, { status: "SUCCESS", utr: event.utr });
  } else if (event.status === "FAILED") {
    await applyDealerPayoutOutcome(batch.id, { status: "FAILED", reason: event.failureReason ?? "The bank rejected the transfer." });
  } else if (event.status === "REVERSED") {
    await applyDealerPayoutOutcome(batch.id, { status: "REVERSED", reason: event.failureReason ?? "The bank returned the transfer." });
  }
  return { status: 200, body: { ok: true, source } };
}

/** Hourly: failed payouts whose backoff has passed are sent again (never one flagged for review). */
export async function retryDueDealerPayouts(now: Date = new Date()): Promise<{ retried: number } | { skipped: string }> {
  if (!(await getRule("dealerAutoPayout")).enabled) return { skipped: "rule dealerAutoPayout off" };
  const due = await db
    .select({ id: dealerPayoutBatches.id })
    .from(dealerPayoutBatches)
    .where(and(eq(dealerPayoutBatches.status, "FAILED"), eq(dealerPayoutBatches.needsReview, false), lte(dealerPayoutBatches.nextRetryAt, now)))
    .limit(200);
  for (const { id } of due) await sendDealerPayout(id).catch((error) => console.error("[dealer-auto-payout] retry failed", id, error));
  return { retried: due.length };
}

/** ADMIN: finance's decision on a payout flagged for review — send again now. */
export async function retryFlaggedPayout(batchId: string, actor: Actor): Promise<DealerPayoutBatch> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can retry payouts.");
  const [b] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batchId));
  if (!b || b.status !== "FAILED") throw conflict("Only a failed payout can be retried.");
  await db.update(dealerPayoutBatches).set({ needsReview: false }).where(eq(dealerPayoutBatches.id, batchId));
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_PAYOUT_SAVED, entityType: "dealer_payout_batch", entityId: batchId, newValue: { retry: true } });
  return sendDealerPayout(batchId, actor);
}

/**
 * ADMIN: the bank upload file of approved (or failed, not with the bank)
 * payouts — beneficiary, account, IFSC, net amount, our reference. Full account
 * numbers are revealed, so the download is audited.
 */
export async function dealerBankFile(actor: Actor): Promise<{ csv: string; count: number }> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can download the bank file.");
  const rows = await db
    .select()
    .from(dealerPayoutBatches)
    // Never sent, or rejected by the bank with no automatic retry due. Not a payout whose outcome is
    // unknown or that finance is reviewing: the bank may already have paid it.
    .where(
      or(
        eq(dealerPayoutBatches.status, "APPROVED"),
        and(eq(dealerPayoutBatches.status, "FAILED"), eq(dealerPayoutBatches.needsReview, false), isNull(dealerPayoutBatches.nextRetryAt)),
      ),
    );
  const lines = ["Beneficiary name,Account number,IFSC,Amount (Rs),Reference,Narration"];
  let count = 0;
  for (const b of rows) {
    const ben = await beneficiaryFor(b);
    if (!ben) continue;
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
    lines.push([esc(ben.name), esc(ben.accountNumber), esc(ben.ifsc), (net(b) / 100).toFixed(2), b.id, esc(`GoKesari commission ${b.periodMonth ?? ""}`.trim())].join(","));
    count += 1;
  }
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_BANK_REVEALED, entityType: "dealer_payout_batch", newValue: { bankFile: true, payouts: count } });
  return { csv: lines.join("\n"), count };
}
