/**
 * F10.2.4 — payout batches and transfers (batch-2026-10 WS-E).
 *
 *   DRAFT ──approve (maker-checker: not the creator)──▶ APPROVED
 *   APPROVED ──execute (provider) / export bank file──▶ PROCESSING
 *   PROCESSING ──all paid──▶ COMPLETED | some paid ──▶ PARTIAL | none ──▶ FAILED
 *   DRAFT / APPROVED ──cancel──▶ CANCELLED (its items' sources are released)
 *
 * Items (one per shop): PENDING → PROCESSING → PAID (UTR) | FAILED (retried
 * with backoff up to payouts.retryMaxAttempts) ; PAID → REVERSED (bank return,
 * carried into the next cycle) ; ON_HOLD / released → CARRIED_FORWARD.
 * Transfers go only to the shop's current VERIFIED bank account (₹1 check),
 * re-checked at execution. Provider webhooks are verified by signature and
 * applied once per event id (payout_events). Every paid item has a UTR.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { decryptSecret } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import {
  bankAccounts,
  payoutBatches,
  payoutCycles,
  payoutEvents,
  payoutItems,
  shops,
  type BankAccount,
  type PayoutBatch,
  type PayoutItem,
  type UserRole,
} from "@/server/db/schema";
import { touchSellerRow } from "@/server/db/split/gate";
import { queueDocumentEmail } from "@/server/documents/email";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { postLedger } from "@/server/services/finance";
import { getRule } from "@/server/services/settings";
import { applyShopWalletEntry } from "@/server/services/shop-wallet";
import { periodLabel, type SystemOrActor } from "./cycle";
import { getPayoutProvider } from "./providers";
import { buildSandboxWebhook } from "./providers/sandbox";
import { PayoutProviderError, type PayoutProvider, type PayoutWebhookEvent } from "./types";

interface Actor {
  id: string;
  role: UserRole;
}

async function lockBatch(batchId: string, tx: DbClient): Promise<PayoutBatch> {
  const [batch] = await tx.select().from(payoutBatches).where(eq(payoutBatches.id, batchId)).for("update");
  if (!batch) throw notFound("Payout batch");
  return batch;
}

async function logEvent(
  tx: DbClient,
  e: { batchId?: string | null; itemId?: string | null; source?: string; eventId?: string; type: string; payload?: Record<string, unknown>; actorId?: string | null },
) {
  await tx
    .insert(payoutEvents)
    .values({
      batchId: e.batchId ?? null,
      itemId: e.itemId ?? null,
      source: e.source ?? "SYSTEM",
      eventId: e.eventId ?? `${e.type}:${e.itemId ?? e.batchId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      type: e.type,
      payload: e.payload ?? {},
      actorId: e.actorId ?? null,
    })
    .onConflictDoNothing();
}

/* ----------------------------------------------------------- batch steps */

/** Maker-checker: with payouts.makerChecker on, the batch's creator cannot approve it. */
export async function approvePayoutBatch(batchId: string, actor: Actor): Promise<PayoutBatch> {
  const rule = await getRule("payouts");
  return db.transaction(async (tx) => {
    const batch = await lockBatch(batchId, tx);
    if (batch.status !== "DRAFT") throw conflict(`A ${batch.status.toLowerCase()} batch cannot be approved.`);
    if (rule.makerChecker && batch.createdBy === actor.id) {
      throw forbidden("Maker-checker: the person who created this batch cannot approve it. Ask another administrator.");
    }
    const [updated] = await tx
      .update(payoutBatches)
      .set({ status: "APPROVED", approvedBy: actor.id, approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(payoutBatches.id, batchId))
      .returning();
    await logEvent(tx, { batchId, type: "BATCH_APPROVED", actorId: actor.id, eventId: `batch-approved:${batchId}` });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PAYOUT_BATCH_STATUS_CHANGED, entityType: "payout_batch", entityId: batchId, previousValue: { status: batch.status }, newValue: { status: "APPROVED" } },
      tx,
    );
    return updated;
  });
}

/** Cancels a DRAFT / APPROVED batch: its held items and every source line are released to the next cycle. */
export async function cancelPayoutBatch(batchId: string, actor: Actor, reason: string): Promise<PayoutBatch> {
  if (reason.trim().length < 3) throw validationFailed("Say why the batch is cancelled.");
  return db.transaction(async (tx) => {
    const batch = await lockBatch(batchId, tx);
    if (batch.status !== "DRAFT" && batch.status !== "APPROVED") throw conflict(`A ${batch.status.toLowerCase()} batch cannot be cancelled.`);
    // Every item's amount moves to the next cycle (carried forward), so nothing is lost or paid twice.
    await tx
      .update(payoutItems)
      .set({ status: "ON_HOLD", holdReason: "RELEASED_TO_NEXT_CYCLE", updatedAt: new Date() })
      .where(and(eq(payoutItems.batchId, batchId), inArray(payoutItems.status, ["PENDING", "ON_HOLD"])));
    const [updated] = await tx
      .update(payoutBatches)
      .set({ status: "CANCELLED", note: reason.trim(), updatedAt: new Date() })
      .where(eq(payoutBatches.id, batchId))
      .returning();
    await logEvent(tx, { batchId, type: "BATCH_CANCELLED", actorId: actor.id, payload: { reason } });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PAYOUT_BATCH_STATUS_CHANGED, entityType: "payout_batch", entityId: batchId, previousValue: { status: batch.status }, newValue: { status: "CANCELLED", reason } },
      tx,
    );
    return updated;
  });
}

/** Recomputes a running batch's status from its items. */
async function settleBatchStatus(batchId: string, tx: DbClient): Promise<void> {
  const [batch] = await tx.select().from(payoutBatches).where(eq(payoutBatches.id, batchId)).for("update");
  if (!batch || !["PROCESSING", "PARTIAL", "FAILED", "COMPLETED"].includes(batch.status)) return;
  // The status comes from the items (seller rows); the batch row itself changes only when the status does.
  await touchSellerRow(tx, payoutBatches, batchId);
  const rule = await getRule("payouts");
  const items = await tx.select().from(payoutItems).where(eq(payoutItems.batchId, batchId));
  const live = items.filter((i) => !["ON_HOLD", "CARRIED_FORWARD"].includes(i.status));
  const open = live.some((i) => i.status === "PENDING" || i.status === "PROCESSING" || (i.status === "FAILED" && i.attempts < rule.retryMaxAttempts && i.provider !== "BANK_FILE"));
  const paid = live.filter((i) => i.status === "PAID").length;
  const status = open ? "PROCESSING" : live.length === 0 || paid === live.length ? "COMPLETED" : paid > 0 ? "PARTIAL" : "FAILED";
  if (status !== batch.status) {
    await tx
      .update(payoutBatches)
      .set({ status, completedAt: status === "PROCESSING" ? null : new Date(), updatedAt: new Date() })
      .where(eq(payoutBatches.id, batchId));
  }
}

/* --------------------------------------------------------- transfers */

function narration(item: PayoutItem): string {
  return `GoKesari payout ${item.id.slice(0, 8)}`;
}

/** The shop's current account when it is verified (the ₹1 check), else null. */
async function verifiedAccount(shopId: string, client: DbClient = db): Promise<BankAccount | null> {
  const [account] = await client.select().from(bankAccounts).where(and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.isCurrent, true)));
  return account?.status === "VERIFIED" ? account : null;
}

function beneficiaryOf(account: BankAccount) {
  return {
    name: account.accountHolderName,
    method: account.method,
    accountNumber: account.accountNumberEncrypted ? decryptSecret(account.accountNumberEncrypted) : null,
    ifsc: account.ifsc,
    upiId: account.upiIdEncrypted ? decryptSecret(account.upiIdEncrypted) : null,
  };
}

function railFor(amountPaise: number, method: BankAccount["method"], rule: { transferMode: "NEFT" | "IMPS" | "RTGS"; rtgsFromPaise: number }) {
  if (method === "UPI") return "UPI" as const;
  return rule.rtgsFromPaise > 0 && amountPaise >= rule.rtgsFromPaise ? ("RTGS" as const) : rule.transferMode;
}

function activeProvider(rule: { provider: string }): PayoutProvider {
  if (rule.provider === "BANK_FILE") throw conflict("Payouts are set to the bank file (rule payouts.provider = BANK_FILE): export the file and mark each payment paid with its UTR.");
  const provider = getPayoutProvider(rule.provider);
  if (!provider || !provider.isConfigured()) throw conflict(`The payout provider ${rule.provider} is not configured (keys missing, or the sandbox on the production site).`);
  return provider;
}

/** Sends one item to the provider (one attempt). The caller has checked the batch. */
async function sendItem(itemId: string, provider: PayoutProvider, actor: SystemOrActor): Promise<PayoutItem> {
  const rule = await getRule("payouts");
  const claimed = await db.transaction(async (tx) => {
    const [item] = await tx.select().from(payoutItems).where(eq(payoutItems.id, itemId)).for("update");
    if (!item || (item.status !== "PENDING" && item.status !== "FAILED")) return null;
    if (item.status === "FAILED" && item.attempts >= rule.retryMaxAttempts) return null;
    const account = await verifiedAccount(item.shopId, tx);
    if (!account) {
      const [held] = await tx
        .update(payoutItems)
        .set({ status: "ON_HOLD", holdReason: "BANK_NOT_VERIFIED", updatedAt: new Date() })
        .where(eq(payoutItems.id, item.id))
        .returning();
      await logEvent(tx, { batchId: item.batchId, itemId: item.id, type: "ITEM_HELD", payload: { reason: "BANK_NOT_VERIFIED" }, actorId: actor.id });
      return { item: held, account: null };
    }
    const [updated] = await tx
      .update(payoutItems)
      .set({ status: "PROCESSING", attempts: item.attempts + 1, provider: provider.name, bankAccountId: account.id, nextAttemptAt: null, failureReason: null, updatedAt: new Date() })
      .where(eq(payoutItems.id, item.id))
      .returning();
    return { item: updated, account };
  });
  if (!claimed) {
    const [current] = await db.select().from(payoutItems).where(eq(payoutItems.id, itemId));
    return current;
  }
  if (!claimed.account) return claimed.item;
  const item = claimed.item;
  try {
    const result = await provider.createTransfer({
      idempotencyKey: `${item.idempotencyKey}:${item.attempts}`,
      referenceId: item.id,
      amountPaise: item.amountPaise,
      mode: railFor(item.amountPaise, claimed.account.method, rule),
      beneficiary: beneficiaryOf(claimed.account),
      narration: narration(item),
      attempt: item.attempts,
    });
    await db.update(payoutItems).set({ providerRef: result.providerRef, updatedAt: new Date() }).where(eq(payoutItems.id, item.id));
    await db.transaction((tx) => logEvent(tx, { batchId: item.batchId, itemId: item.id, source: provider.name, eventId: `transfer:${result.providerRef}`, type: "TRANSFER_CREATED", payload: { status: result.status, attempt: item.attempts }, actorId: actor.id }));
    if (result.status === "SUCCESS" && result.utr) return applyItemOutcome(item.id, { status: "SUCCESS", utr: result.utr, source: provider.name }, actor);
    if (result.status === "FAILED") return applyItemOutcome(item.id, { status: "FAILED", reason: result.failureReason ?? "Rejected by the provider.", source: provider.name }, actor);
  } catch (error) {
    const reason = error instanceof PayoutProviderError || error instanceof Error ? error.message : "The provider could not be reached.";
    return applyItemOutcome(item.id, { status: "FAILED", reason, source: provider.name }, actor);
  }
  const [after] = await db.select().from(payoutItems).where(eq(payoutItems.id, item.id));
  return after;
}

/**
 * Executes an APPROVED batch through the configured provider: every PENDING
 * item with a verified account becomes a transfer. With the sandbox (and
 * payouts.sandboxAutoWebhook) its webhooks are delivered straight away
 * through the same signed path a real provider's would take.
 */
export async function executePayoutBatch(batchId: string, actor: Actor): Promise<{ batch: PayoutBatch; items: PayoutItem[] }> {
  const rule = await getRule("payouts");
  const provider = activeProvider(rule);
  await db.transaction(async (tx) => {
    const batch = await lockBatch(batchId, tx);
    if (batch.status !== "APPROVED" && batch.status !== "PROCESSING") throw conflict(`A ${batch.status.toLowerCase()} batch cannot be executed — approve it first.`);
    if (batch.provider === "BANK_FILE") throw conflict("This batch's bank file was exported: mark its payments paid with their UTRs.");
    await tx
      .update(payoutBatches)
      .set({ status: "PROCESSING", provider: provider.name, processingAt: batch.processingAt ?? new Date(), updatedAt: new Date() })
      .where(eq(payoutBatches.id, batchId));
    await logEvent(tx, { batchId, type: "BATCH_EXECUTED", payload: { provider: provider.name }, actorId: actor.id });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PAYOUT_BATCH_STATUS_CHANGED, entityType: "payout_batch", entityId: batchId, previousValue: { status: batch.status }, newValue: { status: "PROCESSING", provider: provider.name } },
      tx,
    );
  });
  const pending = await db.select().from(payoutItems).where(and(eq(payoutItems.batchId, batchId), eq(payoutItems.status, "PENDING"))).orderBy(asc(payoutItems.createdAt));
  for (const item of pending) await sendItem(item.id, provider, actor);
  if (provider.name === "SANDBOX" && rule.sandboxAutoWebhook) await deliverSandboxWebhooks(batchId);
  await db.transaction((tx) => settleBatchStatus(batchId, tx));
  return getPayoutBatch(batchId);
}

/** The sandbox "bank" answers: one signed webhook per transfer in flight. */
export async function deliverSandboxWebhooks(batchId: string): Promise<number> {
  const inFlight = await db
    .select()
    .from(payoutItems)
    .where(and(eq(payoutItems.batchId, batchId), eq(payoutItems.status, "PROCESSING"), eq(payoutItems.provider, "SANDBOX"), isNotNull(payoutItems.providerRef)));
  for (const item of inFlight) {
    const { rawBody, headers } = buildSandboxWebhook(item.providerRef!, { referenceId: item.id, amountPaise: item.amountPaise, attempt: item.attempts });
    await handlePayoutWebhook("sandbox", rawBody, headers);
  }
  return inFlight.length;
}

/**
 * Retries failed transfers whose backoff has passed (the payout-cycle job,
 * or an administrator for one item). Bank-file items are not retried here:
 * finance marks them by hand.
 */
export async function retryFailedPayouts(options: { itemId?: string; actor: SystemOrActor; now?: Date }): Promise<number> {
  const rule = await getRule("payouts");
  if (rule.provider === "BANK_FILE") return 0;
  const provider = getPayoutProvider(rule.provider);
  if (!provider?.isConfigured()) return 0;
  const due = await db
    .select({ item: payoutItems })
    .from(payoutItems)
    .innerJoin(payoutBatches, eq(payoutBatches.id, payoutItems.batchId))
    .where(
      and(
        eq(payoutItems.status, "FAILED"),
        sql`${payoutItems.attempts} < ${rule.retryMaxAttempts}`,
        inArray(payoutBatches.status, ["PROCESSING", "PARTIAL", "FAILED"]),
        sql`coalesce(${payoutItems.provider}, '') <> 'BANK_FILE'`,
        options.itemId ? eq(payoutItems.id, options.itemId) : lte(payoutItems.nextAttemptAt, options.now ?? new Date()),
      ),
    );
  const batches = new Set<string>();
  for (const { item } of due) {
    await sendItem(item.id, provider, options.actor);
    batches.add(item.batchId);
  }
  if (provider.name === "SANDBOX" && rule.sandboxAutoWebhook) for (const b of batches) await deliverSandboxWebhooks(b);
  for (const b of batches) await db.transaction((tx) => settleBatchStatus(b, tx));
  return due.length;
}

/* ------------------------------------------------------ item outcomes */

type Outcome =
  | { status: "SUCCESS"; utr: string; source: string; markedBy?: string | null }
  | { status: "FAILED"; reason: string; source: string; markedBy?: string | null }
  | { status: "REVERSED"; reason: string; source: string; markedBy?: string | null };

/**
 * Applies a transfer's result: PAID (UTR, journal, wallet top-up, statement
 * to the shop owner), FAILED (retry later or give up), REVERSED (carried
 * into the next cycle). Idempotent: a final state is never changed twice.
 */
async function applyItemOutcome(itemId: string, outcome: Outcome, actor: SystemOrActor): Promise<PayoutItem> {
  const rule = await getRule("payouts");
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(payoutItems).where(eq(payoutItems.id, itemId)).for("update");
    if (!item) throw notFound("Payout item");
    const [shop] = await tx.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, item.shopId));
    const [cycle] = await tx.select().from(payoutCycles).where(eq(payoutCycles.id, item.cycleId));
    const period = cycle ? periodLabel(cycle) : "";

    if (outcome.status === "SUCCESS") {
      if (item.status === "PAID") return item;
      if (!["PROCESSING", "PENDING", "FAILED"].includes(item.status)) throw conflict(`A ${item.status.toLowerCase()} payout cannot be marked paid.`);
      const [clash] = await tx.select({ id: payoutItems.id }).from(payoutItems).where(and(eq(payoutItems.utr, outcome.utr), sql`${payoutItems.id} <> ${item.id}`));
      if (clash) throw conflict("That UTR is already recorded on another payout.");
      const [paid] = await tx
        .update(payoutItems)
        .set({ status: "PAID", utr: outcome.utr, paidAt: new Date(), markedBy: outcome.markedBy ?? null, failureReason: null, nextAttemptAt: null, updatedAt: new Date() })
        .where(eq(payoutItems.id, item.id))
        .returning();
      await postLedger(
        [{ entityType: "SHOP", entityId: item.shopId, entryType: "SHOP_SETTLEMENT", direction: "DEBIT", amountPaise: item.amountPaise, sourceType: "payout_items", sourceId: item.id, reference: outcome.utr, key: `payout-item:${item.id}:paid` }],
        outcome.markedBy ?? null,
        tx,
      );
      const topUp = -(item.breakdown.WALLET_TOPUP ?? 0);
      if (topUp > 0) {
        await applyShopWalletEntry(
          { shopId: item.shopId, type: "MANUAL_CREDIT", amountPaise: topUp, reason: `Top-up from payout (UTR ${outcome.utr})`, idempotencyKey: `payout-topup:${item.id}`, createdBy: outcome.markedBy ?? null },
          tx,
        );
      }
      await logEvent(tx, { batchId: item.batchId, itemId: item.id, type: "ITEM_PAID", payload: { utr: outcome.utr, source: outcome.source }, actorId: outcome.markedBy ?? actor.id });
      if (shop) {
        await emitEvent(
          {
            type: "payout.item_paid",
            subjectId: item.id,
            actor,
            payload: { itemId: item.id, ownerId: shop.ownerId, shopName: shop.name, amount: formatPaise(item.amountPaise), period, utr: outcome.utr },
            idempotencyKey: `payout-item-paid:${item.id}`,
          },
          tx,
        );
        if (rule.statementEmail) {
          await queueDocumentEmail(
            {
              docType: "PAYOUT_STATEMENT",
              docId: item.id,
              userId: shop.ownerId,
              recipientRole: "SHOP_OWNER",
              title: `Payout statement ${period}`,
              body: `${shop.name}: ${formatPaise(item.amountPaise)} was paid to your bank account for ${period} (UTR ${outcome.utr}). The statement is attached as PDF and CSV.`,
              actionUrl: "/shop/finance#statements",
              category: "SHOP",
            },
            tx,
          );
        }
      }
      await recordAudit(
        { actorId: outcome.markedBy ?? null, action: AUDIT_ACTIONS.PAYOUT_ITEM_STATUS_CHANGED, entityType: "payout_item", entityId: item.id, previousValue: { status: item.status }, newValue: { status: "PAID", utr: outcome.utr, source: outcome.source } },
        tx,
      );
      await settleBatchStatus(item.batchId, tx);
      return paid;
    }

    if (outcome.status === "REVERSED") {
      if (item.status === "REVERSED" || item.status === "CARRIED_FORWARD") return item;
      if (item.status !== "PAID") throw conflict("Only a paid payout can be reversed.");
      const [reversed] = await tx
        .update(payoutItems)
        .set({ status: "REVERSED", failureReason: outcome.reason, updatedAt: new Date() })
        .where(eq(payoutItems.id, item.id))
        .returning();
      await postLedger(
        [{ entityType: "SHOP", entityId: item.shopId, entryType: "REVERSAL", direction: "CREDIT", amountPaise: item.amountPaise, sourceType: "payout_items", sourceId: item.id, reference: item.utr, key: `payout-item:${item.id}:reversed` }],
        outcome.markedBy ?? null,
        tx,
      );
      await logEvent(tx, { batchId: item.batchId, itemId: item.id, type: "ITEM_REVERSED", payload: { reason: outcome.reason, source: outcome.source }, actorId: outcome.markedBy ?? actor.id });
      if (shop) {
        await emitEvent(
          {
            type: "payout.item_failed",
            subjectId: item.id,
            actor,
            payload: { itemId: item.id, ownerId: shop.ownerId, shopName: shop.name, amount: formatPaise(item.amountPaise), reason: `${outcome.reason} It will be paid again with the next payout cycle.`, attempts: item.attempts, final: false },
            idempotencyKey: `payout-item-reversed:${item.id}`,
          },
          tx,
        );
      }
      await recordAudit(
        { actorId: outcome.markedBy ?? null, action: AUDIT_ACTIONS.PAYOUT_ITEM_STATUS_CHANGED, entityType: "payout_item", entityId: item.id, previousValue: { status: item.status }, newValue: { status: "REVERSED", reason: outcome.reason } },
        tx,
      );
      return reversed;
    }

    // FAILED
    if (item.status === "PAID" || item.status === "REVERSED" || item.status === "CARRIED_FORWARD") return item;
    if (item.status === "FAILED" && item.failureReason === outcome.reason) return item;
    const final = item.provider === "BANK_FILE" || item.attempts >= rule.retryMaxAttempts;
    const [failed] = await tx
      .update(payoutItems)
      .set({
        status: "FAILED",
        failureReason: outcome.reason,
        markedBy: outcome.markedBy ?? item.markedBy,
        nextAttemptAt: final ? null : new Date(Date.now() + rule.retryBackoffMinutes * Math.max(1, item.attempts) * 60_000),
        updatedAt: new Date(),
      })
      .where(eq(payoutItems.id, item.id))
      .returning();
    await logEvent(tx, { batchId: item.batchId, itemId: item.id, type: "ITEM_FAILED", payload: { reason: outcome.reason, attempts: item.attempts, final, source: outcome.source }, actorId: outcome.markedBy ?? actor.id });
    if (shop) {
      await emitEvent(
        {
          type: "payout.item_failed",
          subjectId: item.id,
          actor,
          payload: { itemId: item.id, ownerId: shop.ownerId, shopName: shop.name, amount: formatPaise(item.amountPaise), reason: outcome.reason, attempts: item.attempts, final },
          idempotencyKey: `payout-item-failed:${item.id}:${item.attempts}`,
        },
        tx,
      );
    }
    await recordAudit(
      { actorId: outcome.markedBy ?? null, action: AUDIT_ACTIONS.PAYOUT_ITEM_STATUS_CHANGED, entityType: "payout_item", entityId: item.id, previousValue: { status: item.status }, newValue: { status: "FAILED", reason: outcome.reason, attempts: item.attempts, final } },
      tx,
    );
    await settleBatchStatus(item.batchId, tx);
    return failed;
  });
}

/* ------------------------------------------------------------ webhooks */

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * A provider's webhook: signature over the raw body first, then the event id
 * — a redelivered event is acknowledged and ignored — then the outcome.
 */
export async function handlePayoutWebhook(providerParam: string, rawBody: string, headers: Headers): Promise<WebhookResult> {
  const provider = getPayoutProvider(providerParam);
  if (!provider) return { status: 404, body: { error: "Unknown payout provider." } };
  if (!provider.isConfigured()) return { status: 503, body: { error: "Payout provider not configured." } };
  if (!provider.verifyWebhook(rawBody, headers)) {
    console.error(`[payouts] ${provider.name} webhook signature verification failed`);
    return { status: 401, body: { error: "Invalid signature." } };
  }
  let event: PayoutWebhookEvent;
  try {
    event = provider.parseWebhook(rawBody, headers);
  } catch {
    return { status: 400, body: { error: "Malformed webhook." } };
  }
  const item = await findItemForEvent(event);
  const [recorded] = await db
    .insert(payoutEvents)
    .values({ batchId: item?.batchId ?? null, itemId: item?.id ?? null, source: provider.name, eventId: event.eventId, type: `WEBHOOK_${event.status}`, payload: event.raw })
    .onConflictDoNothing()
    .returning({ id: payoutEvents.id });
  if (!recorded) return { status: 200, body: { ok: true, duplicate: true } };
  // docs/gig-bank-payouts-2026-10: no shop payout item — a rider bank transfer?
  if (!item) return (await import("@/server/rider-wallet/transfers")).handleRiderTransferEvent(provider.name, event);
  const system = { id: null, role: null };
  if (event.status === "SUCCESS") {
    if (!event.utr) {
      // A paid item must carry a UTR: leave it in progress for finance to complete by hand.
      return { status: 200, body: { ok: true, pending: "Success without a UTR — waiting for the bank reference." } };
    }
    await applyItemOutcome(item.id, { status: "SUCCESS", utr: event.utr.toUpperCase(), source: provider.name }, system);
  } else if (event.status === "FAILED") {
    await applyItemOutcome(item.id, { status: "FAILED", reason: event.failureReason ?? "The bank rejected the transfer.", source: provider.name }, system);
  } else if (event.status === "REVERSED") {
    await applyItemOutcome(item.id, { status: "REVERSED", reason: event.failureReason ?? "The bank returned the transfer.", source: provider.name }, system);
  }
  return { status: 200, body: { ok: true } };
}

async function findItemForEvent(event: PayoutWebhookEvent): Promise<PayoutItem | null> {
  if (event.providerRef) {
    const [byRef] = await db.select().from(payoutItems).where(eq(payoutItems.providerRef, event.providerRef));
    if (byRef) return byRef;
  }
  if (event.referenceId && /^[0-9a-f-]{36}$/i.test(event.referenceId)) {
    const [byId] = await db.select().from(payoutItems).where(eq(payoutItems.id, event.referenceId));
    if (byId) return byId;
  }
  return null;
}

/* ------------------------------------------- bank file and manual marks */

/**
 * Generic NEFT/RTGS bulk-upload file (CSV). Columns:
 *   Sr No, Payment Mode (NEFT/RTGS/IMPS), Amount (INR, 2 decimals), Value Date (DD/MM/YYYY),
 *   Debit Account No (GoKesari, rule payouts.debitAccountNumber), Beneficiary Name,
 *   Beneficiary Account No, Beneficiary IFSC, Beneficiary Email, Narration, Customer Reference (payout item id)
 * Every bank has its own template: the exact column order and date format
 * must be confirmed with GoKesari's bank before the first upload. UPI-only
 * accounts cannot go in a bank file and are listed as skipped.
 */
export const BANK_FILE_COLUMNS = [
  "Sr No",
  "Payment Mode",
  "Amount",
  "Value Date",
  "Debit Account No",
  "Beneficiary Name",
  "Beneficiary Account No",
  "Beneficiary IFSC",
  "Beneficiary Email",
  "Narration",
  "Customer Reference",
] as const;

const csvCell = (value: string | number) => {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportBankFile(batchId: string, actor: Actor, now: Date = new Date()): Promise<{ csv: string; filename: string; rows: number; skipped: { itemId: string; shopName: string; reason: string }[] }> {
  const rule = await getRule("payouts");
  return db.transaction(async (tx) => {
    const batch = await lockBatch(batchId, tx);
    if (batch.status !== "APPROVED" && !(batch.status === "PROCESSING" && batch.provider === "BANK_FILE")) {
      throw conflict(batch.status === "DRAFT" ? "Approve the batch before exporting its bank file." : `A ${batch.status.toLowerCase()} batch has no bank file to export.`);
    }
    const items = await tx
      .select({ item: payoutItems, shopName: shops.name, ownerId: shops.ownerId })
      .from(payoutItems)
      .innerJoin(shops, eq(shops.id, payoutItems.shopId))
      .where(and(eq(payoutItems.batchId, batchId), inArray(payoutItems.status, ["PENDING", "PROCESSING"])))
      .orderBy(asc(payoutItems.createdAt))
      .for("update", { of: payoutItems });
    const ist = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const valueDate = `${ist.slice(8, 10)}/${ist.slice(5, 7)}/${ist.slice(0, 4)}`;
    const rows: string[][] = [];
    const skipped: { itemId: string; shopName: string; reason: string }[] = [];
    for (const { item, shopName } of items) {
      const account = await verifiedAccount(item.shopId, tx);
      if (!account) {
        await tx.update(payoutItems).set({ status: "ON_HOLD", holdReason: "BANK_NOT_VERIFIED", updatedAt: new Date() }).where(eq(payoutItems.id, item.id));
        skipped.push({ itemId: item.id, shopName, reason: "No verified bank account — held for the next cycle." });
        continue;
      }
      if (account.method !== "BANK_ACCOUNT") {
        skipped.push({ itemId: item.id, shopName, reason: "UPI account: pay it outside the file and mark it paid with its UTR." });
        continue;
      }
      const b = beneficiaryOf(account);
      rows.push([
        String(rows.length + 1),
        railFor(item.amountPaise, account.method, rule),
        (item.amountPaise / 100).toFixed(2),
        valueDate,
        rule.debitAccountNumber,
        b.name,
        b.accountNumber ?? "",
        b.ifsc ?? "",
        "",
        narration(item),
        item.id,
      ]);
      if (item.status === "PENDING") {
        await tx
          .update(payoutItems)
          .set({ status: "PROCESSING", provider: "BANK_FILE", bankAccountId: account.id, attempts: item.attempts + 1, updatedAt: new Date() })
          .where(eq(payoutItems.id, item.id));
      }
    }
    const csv = [BANK_FILE_COLUMNS.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
    const checksum = createHash("sha256").update(csv).digest("hex");
    await tx
      .update(payoutBatches)
      .set({ status: "PROCESSING", provider: "BANK_FILE", processingAt: batch.processingAt ?? new Date(), fileExportedAt: new Date(), fileChecksum: checksum, updatedAt: new Date() })
      .where(eq(payoutBatches.id, batchId));
    await logEvent(tx, { batchId, type: "BANK_FILE_EXPORTED", payload: { rows: rows.length, skipped: skipped.length, checksum }, actorId: actor.id });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PAYOUT_BANK_FILE_EXPORTED, entityType: "payout_batch", entityId: batchId, newValue: { rows: rows.length, skipped: skipped.length, checksum } },
      tx,
    );
    return { csv, filename: `gokesari-payouts-${ist}-${batchId.slice(0, 8)}.csv`, rows: rows.length, skipped };
  });
}

const UTR_RE = /^[A-Z0-9]{6,22}$/;

/** Finance records a payment made outside the system (bank file, or by hand) with its UTR. */
export async function markPayoutItemPaid(itemId: string, utrInput: string, actor: Actor): Promise<PayoutItem> {
  const utr = utrInput.trim().toUpperCase();
  if (!UTR_RE.test(utr)) throw validationFailed("Enter the bank's UTR / reference (6–22 letters or digits).");
  const [row] = await db
    .select({ item: payoutItems, batchStatus: payoutBatches.status })
    .from(payoutItems)
    .innerJoin(payoutBatches, eq(payoutBatches.id, payoutItems.batchId))
    .where(eq(payoutItems.id, itemId));
  if (!row) throw notFound("Payout item");
  if (row.batchStatus === "DRAFT" || row.batchStatus === "CANCELLED") throw conflict("Approve the batch before recording payments.");
  if (row.item.status === "PAID") {
    if (row.item.utr === utr) return row.item;
    throw conflict("This payout is already marked paid.");
  }
  if (row.item.status === "PENDING" || row.item.status === "FAILED") {
    // Paid by hand: the account must still be verified.
    const account = await verifiedAccount(row.item.shopId);
    if (!account) throw conflict("The shop has no verified bank account — the payout stays on hold.");
  }
  if (row.batchStatus === "APPROVED") {
    await db.update(payoutBatches).set({ status: "PROCESSING", provider: row.item.provider ?? "BANK_FILE", processingAt: new Date(), updatedAt: new Date() }).where(eq(payoutBatches.id, row.item.batchId));
  }
  return applyItemOutcome(itemId, { status: "SUCCESS", utr, source: "MANUAL", markedBy: actor.id }, actor);
}

export async function markPayoutItemFailed(itemId: string, reason: string, actor: Actor): Promise<PayoutItem> {
  if (reason.trim().length < 3) throw validationFailed("Say why the bank rejected the payment.");
  const [item] = await db.select().from(payoutItems).where(eq(payoutItems.id, itemId));
  if (!item) throw notFound("Payout item");
  if (item.status !== "PROCESSING") throw conflict("Only a payment in progress can be marked failed.");
  return applyItemOutcome(itemId, { status: "FAILED", reason: reason.trim(), source: "MANUAL", markedBy: actor.id }, actor);
}

/** A failed (or stuck pending) payout is moved to the next cycle instead of being retried. */
export async function releasePayoutItem(itemId: string, actor: Actor): Promise<PayoutItem> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(payoutItems).where(eq(payoutItems.id, itemId)).for("update");
    if (!item) throw notFound("Payout item");
    if (item.status !== "FAILED" && item.status !== "PENDING") throw conflict(`A ${item.status.toLowerCase()} payout cannot be moved to the next cycle.`);
    const [held] = await tx
      .update(payoutItems)
      .set({ status: "ON_HOLD", holdReason: "RELEASED_TO_NEXT_CYCLE", nextAttemptAt: null, updatedAt: new Date() })
      .where(eq(payoutItems.id, itemId))
      .returning();
    await logEvent(tx, { batchId: item.batchId, itemId, type: "ITEM_RELEASED", actorId: actor.id });
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.PAYOUT_ITEM_STATUS_CHANGED, entityType: "payout_item", entityId: itemId, previousValue: { status: item.status }, newValue: { status: "ON_HOLD", holdReason: "RELEASED_TO_NEXT_CYCLE" } },
      tx,
    );
    await settleBatchStatus(item.batchId, tx);
    return held;
  });
}

/** Admin "retry now" for one failed item (ignores the backoff). */
export async function retryPayoutItem(itemId: string, actor: Actor): Promise<PayoutItem> {
  const [item] = await db.select().from(payoutItems).where(eq(payoutItems.id, itemId));
  if (!item) throw notFound("Payout item");
  if (item.status !== "FAILED") throw conflict("Only a failed payout can be retried.");
  const rule = await getRule("payouts");
  if (item.provider === "BANK_FILE" || rule.provider === "BANK_FILE") throw conflict("Bank-file payments are retried at the bank: mark it paid with the UTR, or move it to the next cycle.");
  if (item.attempts >= rule.retryMaxAttempts) throw conflict("All retries are used: move it to the next cycle.");
  await retryFailedPayouts({ itemId, actor });
  const [after] = await db.select().from(payoutItems).where(eq(payoutItems.id, itemId));
  return after;
}

/* --------------------------------------------------------------- reads */

export async function getPayoutBatch(batchId: string): Promise<{ batch: PayoutBatch; items: PayoutItem[] }> {
  const [batch] = await db.select().from(payoutBatches).where(eq(payoutBatches.id, batchId));
  if (!batch) throw notFound("Payout batch");
  const items = await db.select().from(payoutItems).where(eq(payoutItems.batchId, batchId)).orderBy(asc(payoutItems.createdAt));
  return { batch, items };
}

export async function listPayoutCycles(limit = 20) {
  return db.select().from(payoutCycles).orderBy(desc(payoutCycles.cycleStart)).limit(limit);
}

export async function listPayoutBatches(limit = 20) {
  return db
    .select({ batch: payoutBatches, cycleStart: payoutCycles.cycleStart, cycleEnd: payoutCycles.cycleEnd })
    .from(payoutBatches)
    .innerJoin(payoutCycles, eq(payoutCycles.id, payoutBatches.cycleId))
    .orderBy(desc(payoutBatches.createdAt))
    .limit(limit);
}

export async function listPayoutItems(options: { batchId?: string; shopId?: string; limit?: number } = {}) {
  return db
    .select({ item: payoutItems, shopName: shops.name, cycleStart: payoutCycles.cycleStart, cycleEnd: payoutCycles.cycleEnd })
    .from(payoutItems)
    .innerJoin(shops, eq(shops.id, payoutItems.shopId))
    .innerJoin(payoutCycles, eq(payoutCycles.id, payoutItems.cycleId))
    .where(and(options.batchId ? eq(payoutItems.batchId, options.batchId) : undefined, options.shopId ? eq(payoutItems.shopId, options.shopId) : undefined))
    .orderBy(desc(payoutItems.createdAt))
    .limit(Math.min(options.limit ?? 200, 1000));
}
