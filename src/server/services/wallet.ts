/**
 * Wallet service — the financial core (requirements §19–§24, §48).
 *
 * Three mechanisms together make double-spending and lost updates impossible:
 *
 *  1. **Row lock.** Every mutation opens with `SELECT … FOR UPDATE` on the wallet
 *     row, so concurrent deductions for the same wallet serialise instead of
 *     interleaving. Read-modify-write of the balance is therefore atomic.
 *  2. **Idempotency key.** Every ledger row carries a UNIQUE key. A retried
 *     request (network retry, double-clicked button, replayed webhook, re-run
 *     cron) finds the existing transaction and returns it unchanged instead of
 *     applying the amount twice.
 *  3. **CHECK constraint.** `balance_paise >= 0` is enforced by PostgreSQL, so
 *     even a logic bug cannot persist a negative balance.
 *
 * READ COMMITTED is deliberate: `FOR UPDATE` already provides the needed
 * serialisation, and it avoids the spurious serialisation failures (and retry
 * loops) that REPEATABLE READ would introduce under load.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import { isUniqueViolation } from "@/lib/errors";
import { insufficientBalance, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  walletTransactions,
  wallets,
  type Wallet,
  type WalletTransaction,
} from "@/server/db/schema";

export type WalletTxnType =
  | "TOP_UP"
  | "PRODUCT_PURCHASE"
  | "SUBSCRIPTION_DEDUCTION"
  | "REFUND"
  | "PROMOTIONAL_CREDIT"
  | "MANUAL_CREDIT"
  | "MANUAL_DEBIT"
  | "REVERSAL";

const CREDIT_TYPES: ReadonlySet<WalletTxnType> = new Set([
  "TOP_UP",
  "REFUND",
  "PROMOTIONAL_CREDIT",
  "MANUAL_CREDIT",
]);

export interface WalletMutation {
  userId: string;
  /** Always a positive magnitude; direction is derived from `type`. */
  amountPaise: number;
  type: WalletTxnType;
  /**
   * Stable key identifying this logical operation. Reusing it is safe and is
   * the intended way to retry.
   */
  idempotencyKey: string;
  description: string;
  orderId?: string | null;
  subscriptionId?: string | null;
  paymentId?: string | null;
  voucherRedemptionId?: string | null;
  createdBy?: string | null;
  /**
   * Explicit override for the promotional slice of this movement (§27–§29).
   * Required-in-spirit for REFUND (restore the original purchase's exact
   * split, not a guess) and implied-in-full for PROMOTIONAL_CREDIT (the
   * entire amount is promotional by definition — passing this is optional
   * there). Left undefined for a PURCHASE/SUBSCRIPTION_DEDUCTION debit, the
   * engine computes it itself using PROMOTIONAL_FIRST spending (§28).
   * Ignored for TOP_UP/MANUAL_CREDIT, which are always customer-funded.
   */
  promotionalAmountPaise?: number;
}

export interface WalletMutationResult {
  transaction: WalletTransaction;
  balancePaise: number;
  promotionalBalancePaise: number;
  /** True when the key had already been used and no new money moved. */
  deduplicated: boolean;
}

/* ------------------------------------------------------------- read APIs */

export async function getOrCreateWallet(
  userId: string,
  client: DbClient = db,
): Promise<Wallet> {
  const existing = await client.query.wallets.findFirst({
    where: eq(wallets.userId, userId),
  });
  if (existing) return existing;

  await client.insert(wallets).values({ userId }).onConflictDoNothing();

  const created = await client.query.wallets.findFirst({
    where: eq(wallets.userId, userId),
  });
  if (!created) throw notFound("Wallet");
  return created;
}

export async function getWalletByUserId(
  userId: string,
): Promise<Wallet | undefined> {
  return db.query.wallets.findFirst({ where: eq(wallets.userId, userId) });
}

export async function listTransactions(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<WalletTransaction[]> {
  const limit = Math.min(options.limit ?? 50, 200);
  return db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.userId, userId))
    .orderBy(desc(walletTransactions.createdAt))
    .limit(limit)
    .offset(options.offset ?? 0);
}

/** Sum of debits applied today — powers the "Today's deduction" tile (§19). */
export async function todaysDeductionPaise(userId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(-SUM(${walletTransactions.amountPaise}), 0)::bigint`,
    })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.userId, userId),
        sql`${walletTransactions.amountPaise} < 0`,
        sql`${walletTransactions.createdAt} >= date_trunc('day', now())`,
      ),
    );
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------- mutation engine */

/**
 * Applies a signed balance change atomically and writes the immutable ledger row.
 *
 * Safe to call inside a caller-supplied transaction (`client`) so that a wallet
 * deduction and the order it pays for commit together — if either fails, both
 * roll back and no money moves.
 */
export async function applyWalletMutation(
  mutation: WalletMutation,
  client?: DbClient,
): Promise<WalletMutationResult> {
  if (!Number.isInteger(mutation.amountPaise) || mutation.amountPaise <= 0) {
    throw validationFailed("Amount must be a positive whole number of paise.");
  }
  if (!mutation.idempotencyKey.trim()) {
    throw validationFailed("An idempotency key is required.");
  }

  const run = async (tx: DbClient): Promise<WalletMutationResult> => {
    // 1. Lock the wallet row. Concurrent mutations queue here.
    const [locked] = await tx
      .select()
      .from(wallets)
      .where(eq(wallets.userId, mutation.userId))
      .for("update");

    if (!locked) throw notFound("Wallet");

    // 2. Inside the lock, check whether this operation already happened.
    const prior = await tx.query.walletTransactions.findFirst({
      where: eq(walletTransactions.idempotencyKey, mutation.idempotencyKey),
    });
    if (prior) {
      return {
        transaction: prior,
        balancePaise: locked.balancePaise,
        promotionalBalancePaise: locked.promotionalBalancePaise,
        deduplicated: true,
      };
    }

    const isCredit = CREDIT_TYPES.has(mutation.type);
    const signedAmount = isCredit ? mutation.amountPaise : -mutation.amountPaise;
    const previousBalance = locked.balancePaise;
    const newBalance = previousBalance + signedAmount;

    // 3. Refuse debits that would overdraw. Checked before any write.
    if (newBalance < 0) {
      throw insufficientBalance(mutation.amountPaise, previousBalance);
    }

    // 4. Determine the promotional slice of THIS movement (§27–§29).
    const previousPromotional = locked.promotionalBalancePaise;
    let signedPromotionalAmount: number;

    if (mutation.promotionalAmountPaise !== undefined) {
      // Caller knows exactly (a REFUND restoring an original split, or an
      // explicit PROMOTIONAL_CREDIT amount).
      signedPromotionalAmount = isCredit
        ? mutation.promotionalAmountPaise
        : -mutation.promotionalAmountPaise;
    } else if (mutation.type === "PROMOTIONAL_CREDIT") {
      // The whole amount is promotional by definition.
      signedPromotionalAmount = mutation.amountPaise;
    } else if (isCredit) {
      // TOP_UP, MANUAL_CREDIT, undirected REFUND: customer-funded.
      signedPromotionalAmount = 0;
    } else {
      // §28 PROMOTIONAL_FIRST: a debit draws down promotional balance before
      // touching customer-funded balance.
      const promoUsed = Math.min(mutation.amountPaise, previousPromotional);
      signedPromotionalAmount = -promoUsed;
    }

    const newPromotionalBalance = previousPromotional + signedPromotionalAmount;
    if (newPromotionalBalance < 0 || newPromotionalBalance > newBalance) {
      // Should be unreachable given the checks above; a hard stop is safer
      // than silently persisting an inconsistent split.
      throw validationFailed("Promotional balance calculation is inconsistent.");
    }

    // 5. Move the money and record it. Both statements share this transaction.
    await tx
      .update(wallets)
      .set({
        balancePaise: newBalance,
        promotionalBalancePaise: newPromotionalBalance,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, locked.id));

    const [transaction] = await tx
      .insert(walletTransactions)
      .values({
        walletId: locked.id,
        userId: mutation.userId,
        type: mutation.type,
        amountPaise: signedAmount,
        promotionalAmountPaise: signedPromotionalAmount,
        previousBalancePaise: previousBalance,
        newBalancePaise: newBalance,
        orderId: mutation.orderId ?? null,
        subscriptionId: mutation.subscriptionId ?? null,
        paymentId: mutation.paymentId ?? null,
        voucherRedemptionId: mutation.voucherRedemptionId ?? null,
        idempotencyKey: mutation.idempotencyKey,
        description: mutation.description,
        createdBy: mutation.createdBy ?? null,
      })
      .returning();

    return {
      transaction,
      balancePaise: newBalance,
      promotionalBalancePaise: newPromotionalBalance,
      deduplicated: false,
    };
  };

  try {
    // Reuse the caller's transaction when given one, so callers can compose
    // wallet movement with order creation atomically.
    return client ? await run(client) : await db.transaction(run);
  } catch (error) {
    // Belt and braces: if two transactions somehow raced past the in-lock
    // check, the unique index still stops the double-charge. Return the
    // winner's row rather than surfacing a database error.
    if (isUniqueViolation(error)) {
      const existing = await db.query.walletTransactions.findFirst({
        where: eq(walletTransactions.idempotencyKey, mutation.idempotencyKey),
      });
      if (existing) {
        const wallet = await getWalletByUserId(mutation.userId);
        return {
          transaction: existing,
          balancePaise: wallet?.balancePaise ?? existing.newBalancePaise,
          promotionalBalancePaise: wallet?.promotionalBalancePaise ?? 0,
          deduplicated: true,
        };
      }
    }
    throw error;
  }
}

export function credit(
  mutation: Omit<WalletMutation, "type"> & { type?: WalletTxnType },
  client?: DbClient,
): Promise<WalletMutationResult> {
  return applyWalletMutation(
    { ...mutation, type: mutation.type ?? "TOP_UP" },
    client,
  );
}

export function debit(
  mutation: Omit<WalletMutation, "type"> & { type?: WalletTxnType },
  client?: DbClient,
): Promise<WalletMutationResult> {
  return applyWalletMutation(
    { ...mutation, type: mutation.type ?? "PRODUCT_PURCHASE" },
    client,
  );
}

/**
 * Non-authoritative affordability check for UI hints only.
 *
 * Never gate a purchase on this — by the time the answer is read the balance may
 * have changed. The authoritative check happens under the row lock inside
 * `applyWalletMutation`.
 */
export async function canAfford(
  userId: string,
  amountPaise: number,
): Promise<boolean> {
  const wallet = await getWalletByUserId(userId);
  return (wallet?.balancePaise ?? 0) >= amountPaise;
}

export async function updateWalletSettings(
  userId: string,
  settings: {
    lowBalanceThresholdPaise?: number;
    autoRechargeEnabled?: boolean;
    autoRechargeTriggerPaise?: number | null;
    autoRechargeAmountPaise?: number | null;
  },
): Promise<Wallet> {
  if (
    settings.lowBalanceThresholdPaise !== undefined &&
    settings.lowBalanceThresholdPaise < 0
  ) {
    throw validationFailed("Low balance threshold cannot be negative.");
  }
  // DEF-07 (docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md): this setting
  // could previously be enabled and stored, but nothing anywhere ever read
  // it to trigger a recharge — a caller enabling it would reasonably but
  // wrongly believe it does something. Real auto-recharge needs a saved
  // payment method / mandate, which the Cashfree integration doesn't have
  // yet; block enabling it until that exists, rather than silently promise
  // behaviour the product doesn't deliver.
  if (settings.autoRechargeEnabled) {
    throw validationFailed(
      "Auto-recharge is not available yet. You can top up your wallet manually any time.",
    );
  }

  const [updated] = await db
    .update(wallets)
    .set({ ...settings, updatedAt: new Date() })
    .where(eq(wallets.userId, userId))
    .returning();

  if (!updated) throw notFound("Wallet");
  return updated;
}

/**
 * Refunds a debit while preserving its original customer-funded /
 * promotional split (§29).
 *
 * "Preserving the split" means: read back how much of the ORIGINAL debit's
 * amount was promotional (`promotionalAmountPaise` on that ledger row, always
 * negative or zero for a debit), and credit exactly that much back as
 * promotional. A flat `applyWalletMutation(..., type: "REFUND")` with no
 * explicit split would instead default the whole refund to customer-funded —
 * correct for a refund of a TOP_UP, wrong for a refund of a purchase that
 * drew on promotional credit.
 *
 * `referenceType`/`referenceId` identify the ORIGINAL debit to refund —
 * typically `{ referenceType: "orderId", referenceId: order.id }` or
 * `{ referenceType: "subscriptionId", referenceId: ... }` — whichever column
 * the original PRODUCT_PURCHASE / SUBSCRIPTION_DEDUCTION was recorded against.
 */
export async function refundOriginalDebit(
  input: {
    userId: string;
    referenceType: "orderId" | "subscriptionId";
    referenceId: string;
    idempotencyKey: string;
    description: string;
    createdBy?: string | null;
    /**
     * Refund only this many paise instead of the full original debit — e.g. a
     * goods-only refund on a self-cancelled dispatched order that keeps the
     * delivery fee (D10 — see docs/gokesari-audit/GOKESARI_AUDIT_FINDINGS.md
     * DEF-08). Must be a positive amount not exceeding the original debit.
     * The promotional portion restored is the SAME proportion of this amount
     * as the original debit's own promotional share, so a partial refund can
     * never restore more promotional credit than was actually spent on the
     * refunded portion. Omit for the original, unchanged full-refund behaviour.
     */
    amountPaise?: number;
  },
  client?: DbClient,
): Promise<WalletMutationResult> {
  const column =
    input.referenceType === "orderId"
      ? walletTransactions.orderId
      : walletTransactions.subscriptionId;

  const original = await (client ?? db).query.walletTransactions.findFirst({
    where: and(
      eq(column, input.referenceId),
      eq(walletTransactions.userId, input.userId),
      sql`${walletTransactions.amountPaise} < 0`,
    ),
    orderBy: desc(walletTransactions.createdAt),
  });
  if (!original) {
    throw notFound("Original wallet debit for this reference");
  }

  const fullRefundAmountPaise = -original.amountPaise;
  const fullPromotionalToRestore = -original.promotionalAmountPaise;

  const refundAmountPaise = input.amountPaise ?? fullRefundAmountPaise;
  if (!Number.isInteger(refundAmountPaise) || refundAmountPaise <= 0) {
    throw validationFailed("Refund amount must be a positive whole number of paise.");
  }
  if (refundAmountPaise > fullRefundAmountPaise) {
    throw validationFailed("Refund amount cannot exceed the original debit.");
  }
  const promotionalToRestore =
    refundAmountPaise === fullRefundAmountPaise
      ? fullPromotionalToRestore
      : Math.round(fullPromotionalToRestore * (refundAmountPaise / fullRefundAmountPaise));

  return applyWalletMutation(
    {
      userId: input.userId,
      amountPaise: refundAmountPaise,
      type: "REFUND",
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      orderId: input.referenceType === "orderId" ? input.referenceId : undefined,
      subscriptionId: input.referenceType === "subscriptionId" ? input.referenceId : undefined,
      createdBy: input.createdBy ?? null,
      promotionalAmountPaise: promotionalToRestore,
    },
    client,
  );
}

/** Customer-funded balance = total minus promotional. Never stored directly — always derived, so it cannot drift (§27). */
export function customerFundedBalancePaise(wallet: Wallet): number {
  return wallet.balancePaise - wallet.promotionalBalancePaise;
}
