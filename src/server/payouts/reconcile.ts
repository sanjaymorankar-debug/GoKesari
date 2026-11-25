/**
 * Payout reconcile (hourly, 23-Nov-2026): asks the payout provider about every
 * transfer whose answer has not come.
 *
 *   - shop payout items PROCESSING for more than STALE_MINUTES,
 *   - rider bank transfers PROCESSING for more than STALE_MINUTES, or FAILED
 *     and waiting for finance (outcome unknown, or retries used up),
 *   - dealer commission payouts PROCESSING for more than STALE_MINUTES, or
 *     FAILED and waiting for finance.
 *
 * Each is looked up by the transfer id saved before its request was sent
 * (provider_transfer_id) and settled through the same outcome appliers the
 * webhooks use: SUCCESS (with a UTR) pays it, FAILED fails it, REVERSED
 * returns it. NOT_FOUND means the request never reached the provider: the same
 * attempt is sent again with the same transfer id (the provider's idempotency
 * key), so it can never be paid twice. A provider without a status lookup, or
 * not configured, is skipped. Parked webhooks (matched nothing when they came)
 * are replayed too. Safe to run again at any time.
 */
import { and, asc, eq, gte, isNotNull, isNull, lt, or } from "drizzle-orm";

import { db } from "@/server/db";
import { dealerPayoutBatches, payoutItems, payoutWebhookParked, riderBankTransfers } from "@/server/db/schema";
import { getPayoutProvider } from "./providers";
import type { PayoutProvider, PayoutWebhookEvent, TransferStatus } from "./types";

export const STALE_MINUTES = 30;
/** Rows looked at per kind per run (the provider's rate limit). */
const BATCH = 100;
/** Parked webhooks are replayed for this long, then left for finance. */
const PARKED_REPLAY_DAYS = 3;

const SYSTEM = { id: null, role: null };

export interface ReconcileSummary {
  checked: number;
  settled: number;
  resent: number;
  unchanged: number;
  parkedReplayed: number;
  errors: string[];
}

function lookupProvider(name: string | null): (PayoutProvider & { getTransfer: NonNullable<PayoutProvider["getTransfer"]> }) | null {
  if (!name) return null;
  const provider = getPayoutProvider(name);
  if (!provider || !provider.isConfigured() || !provider.getTransfer) return null;
  return provider as PayoutProvider & { getTransfer: NonNullable<PayoutProvider["getTransfer"]> };
}

type Settle = (status: TransferStatus) => Promise<"settled" | "unchanged">;

async function check(
  summary: ReconcileSummary,
  label: string,
  providerName: string | null,
  transferId: string,
  settle: Settle,
  resend: () => Promise<unknown>,
): Promise<void> {
  const provider = lookupProvider(providerName);
  if (!provider) return;
  summary.checked += 1;
  try {
    const status = await provider.getTransfer(transferId);
    if (status.status === "NOT_FOUND") {
      const sent = await resend();
      if (sent) summary.resent += 1;
      else summary.unchanged += 1;
      return;
    }
    if ((await settle(status)) === "settled") summary.settled += 1;
    else summary.unchanged += 1;
  } catch (error) {
    summary.errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const reason = (s: TransferStatus, fallback: string) => s.failureReason ?? fallback;

export async function reconcilePayouts(now: Date = new Date()): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, settled: 0, resent: 0, unchanged: 0, parkedReplayed: 0, errors: [] };
  const staleBefore = new Date(now.getTime() - STALE_MINUTES * 60_000);
  const batches = await import("./batches");
  const rider = await import("@/server/rider-wallet/transfers");
  const dealer = await import("@/server/dealers/auto-payout");

  /* Shop payout items. */
  const items = await db
    .select()
    .from(payoutItems)
    .where(and(eq(payoutItems.status, "PROCESSING"), isNotNull(payoutItems.providerTransferId), lt(payoutItems.updatedAt, staleBefore)))
    .orderBy(asc(payoutItems.updatedAt))
    .limit(BATCH);
  for (const item of items) {
    await check(
      summary,
      `payout item ${item.id}`,
      item.provider,
      item.providerTransferId!,
      async (s) => {
        if (s.providerRef && !item.providerRef) await db.update(payoutItems).set({ providerRef: s.providerRef, updatedAt: new Date() }).where(eq(payoutItems.id, item.id));
        if (s.status === "SUCCESS" && s.utr) await batches.applyItemOutcome(item.id, { status: "SUCCESS", utr: s.utr.toUpperCase(), source: `${item.provider}:RECONCILE` }, SYSTEM);
        // A return before the payment was recorded: the money is back — a failed attempt.
        else if (s.status === "FAILED" || s.status === "REVERSED") await batches.applyItemOutcome(item.id, { status: "FAILED", reason: reason(s, "The bank rejected the transfer."), source: `${item.provider}:RECONCILE` }, SYSTEM);
        else return "unchanged";
        return "settled"; // applyItemOutcome also re-settles the batch's status
      },
      () => batches.resendPayoutItem(item.id, SYSTEM),
    );
  }

  /* Rider bank transfers. */
  const transfers = await db
    .select()
    .from(riderBankTransfers)
    .where(
      and(
        isNotNull(riderBankTransfers.providerTransferId),
        or(
          and(eq(riderBankTransfers.status, "PROCESSING"), lt(riderBankTransfers.updatedAt, staleBefore)),
          and(eq(riderBankTransfers.status, "FAILED"), eq(riderBankTransfers.needsReview, true)),
        ),
      ),
    )
    .orderBy(asc(riderBankTransfers.updatedAt))
    .limit(BATCH);
  for (const t of transfers) {
    await check(
      summary,
      `rider transfer ${t.id}`,
      t.provider,
      t.providerTransferId!,
      async (s) => {
        if (s.providerRef && !t.providerRef) await db.update(riderBankTransfers).set({ providerRef: s.providerRef, updatedAt: new Date() }).where(eq(riderBankTransfers.id, t.id));
        const before = t.status;
        let after: string = before;
        if (s.status === "SUCCESS" && s.utr) after = (await rider.applyOutcome(t.id, { status: "SUCCESS", utr: s.utr.toUpperCase(), source: `${t.provider}:RECONCILE` })).status;
        else if (s.status === "FAILED" || s.status === "REVERSED") after = (await rider.applyOutcome(t.id, { status: "FAILED", reason: reason(s, "The bank rejected the transfer."), definite: true, source: `${t.provider}:RECONCILE` })).status;
        else return "unchanged";
        return after !== before || rider.riderOutcomeUnknown(t) ? "settled" : "unchanged";
      },
      // Only a transfer in progress or of unknown outcome is sent again (resendRiderTransfer checks).
      () => rider.resendRiderTransfer(t.id),
    );
  }

  /* Dealer commission payouts. */
  const payouts = await db
    .select()
    .from(dealerPayoutBatches)
    .where(
      and(
        isNotNull(dealerPayoutBatches.providerTransferId),
        or(
          and(eq(dealerPayoutBatches.status, "PROCESSING"), or(isNull(dealerPayoutBatches.sentAt), lt(dealerPayoutBatches.sentAt, staleBefore))),
          and(eq(dealerPayoutBatches.status, "FAILED"), eq(dealerPayoutBatches.needsReview, true)),
        ),
      ),
    )
    .orderBy(asc(dealerPayoutBatches.createdAt))
    .limit(BATCH);
  for (const b of payouts) {
    await check(
      summary,
      `dealer payout ${b.id}`,
      b.provider,
      b.providerTransferId!,
      async (s) => {
        if (s.providerRef && !b.providerRef) await db.update(dealerPayoutBatches).set({ providerRef: s.providerRef }).where(eq(dealerPayoutBatches.id, b.id));
        let after: string = b.status;
        if (s.status === "SUCCESS" && s.utr) after = (await dealer.applyDealerPayoutOutcome(b.id, { status: "SUCCESS", utr: s.utr })).status;
        else if (s.status === "FAILED" || s.status === "REVERSED") after = (await dealer.applyDealerPayoutOutcome(b.id, { status: "FAILED", reason: reason(s, "The bank rejected the transfer.") })).status;
        else return "unchanged";
        return after !== b.status || b.needsReview ? "settled" : "unchanged";
      },
      () => dealer.resendDealerPayout(b.id),
    );
  }

  /* Webhooks that matched nothing when they came (their payout may exist now). */
  const parked = await db
    .select()
    .from(payoutWebhookParked)
    .where(and(isNull(payoutWebhookParked.matchedAt), gte(payoutWebhookParked.firstSeenAt, new Date(now.getTime() - PARKED_REPLAY_DAYS * 86_400_000))))
    .orderBy(asc(payoutWebhookParked.firstSeenAt))
    .limit(BATCH);
  for (const p of parked) {
    try {
      const result = await batches.processPayoutEvent(p.source, p.payload as unknown as PayoutWebhookEvent);
      if (result.status === 200) summary.parkedReplayed += 1;
    } catch (error) {
      summary.errors.push(`parked webhook ${p.eventId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return summary;
}
