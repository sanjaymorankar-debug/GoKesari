/**
 * Wallet integration tests (requirement §48 — financial integrity).
 *
 * These run against real PostgreSQL. The concurrency cases are the point of the
 * whole suite: they would pass trivially against a mock and only prove anything
 * against a real database with real row locks.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import { db } from "@/server/db";
import { walletTransactions, wallets } from "@/server/db/schema";
import {
  applyWalletMutation,
  getOrCreateWallet,
  listTransactions,
  updateWalletSettings,
} from "@/server/services/wallet";
import { createUserWithWallet, resetDatabase } from "../helpers/fixtures";

beforeEach(resetDatabase);

describe("wallet credit and debit", () => {
  it("credits the balance and writes a self-consistent ledger row", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });

    const result = await applyWalletMutation({
      userId: user.id,
      amountPaise: 500_000,
      type: "TOP_UP",
      idempotencyKey: "topup-1",
      description: "Wallet top-up",
    });

    expect(result.balancePaise).toBe(500_000);
    expect(result.deduplicated).toBe(false);
    expect(result.transaction.previousBalancePaise).toBe(0);
    expect(result.transaction.amountPaise).toBe(500_000);
    expect(result.transaction.newBalancePaise).toBe(500_000);
  });

  it("records debits as negative amounts", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 100_000 });

    const result = await applyWalletMutation({
      userId: user.id,
      amountPaise: 14_000,
      type: "SUBSCRIPTION_DEDUCTION",
      idempotencyKey: "sub-1",
      description: "Milk 2 L",
    });

    expect(result.balancePaise).toBe(86_000);
    expect(result.transaction.amountPaise).toBe(-14_000);
  });

  it("refuses a debit that would overdraw, leaving the balance untouched", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 10_000 });

    await expect(
      applyWalletMutation({
        userId: user.id,
        amountPaise: 14_000,
        type: "SUBSCRIPTION_DEDUCTION",
        idempotencyKey: "sub-overdraw",
        description: "Milk 2 L",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" });

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, user.id),
    });
    expect(wallet?.balancePaise).toBe(10_000);

    // A rejected debit must not leave a ledger row behind.
    expect(await listTransactions(user.id)).toHaveLength(0);
  });

  it("reports the shortfall so the UI can suggest a recharge amount", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 10_000 });

    const error = await applyWalletMutation({
      userId: user.id,
      amountPaise: 14_000,
      type: "PRODUCT_PURCHASE",
      idempotencyKey: "shortfall",
      description: "Order",
    }).catch((e: unknown) => e as AppError);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).details).toMatchObject({
      requiredPaise: 14_000,
      availablePaise: 10_000,
      shortfallPaise: 4_000,
    });
  });
});

describe("idempotency", () => {
  it("does not double-charge when the same key is replayed", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 100_000 });

    const first = await applyWalletMutation({
      userId: user.id,
      amountPaise: 14_000,
      type: "SUBSCRIPTION_DEDUCTION",
      idempotencyKey: "sub:2026-08-20",
      description: "Milk 2 L",
    });
    const replay = await applyWalletMutation({
      userId: user.id,
      amountPaise: 14_000,
      type: "SUBSCRIPTION_DEDUCTION",
      idempotencyKey: "sub:2026-08-20",
      description: "Milk 2 L",
    });

    expect(first.deduplicated).toBe(false);
    expect(replay.deduplicated).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.balancePaise).toBe(86_000);

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, user.id),
    });
    expect(wallet?.balancePaise).toBe(86_000);
    expect(await listTransactions(user.id)).toHaveLength(1);
  });

  it("deduplicates even when replays are fired concurrently", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 100_000 });

    const attempts = Array.from({ length: 10 }, () =>
      applyWalletMutation({
        userId: user.id,
        amountPaise: 14_000,
        type: "SUBSCRIPTION_DEDUCTION",
        idempotencyKey: "concurrent-replay",
        description: "Milk 2 L",
      }),
    );
    const results = await Promise.all(attempts);

    // Exactly one attempt moved money; the rest returned the same row.
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.transaction.id));
    expect(ids.size).toBe(1);

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, user.id),
    });
    expect(wallet?.balancePaise).toBe(86_000);
  });
});

describe("concurrency", () => {
  it("serialises concurrent debits without losing updates", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 100_000 });

    // 10 distinct ₹100 debits fired at once. A naive read-modify-write would
    // lose updates here and leave the balance too high.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        applyWalletMutation({
          userId: user.id,
          amountPaise: 10_000,
          type: "PRODUCT_PURCHASE",
          idempotencyKey: `distinct-${i}`,
          description: `Order ${i}`,
        }),
      ),
    );

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, user.id),
    });
    expect(wallet?.balancePaise).toBe(0);
    expect(await listTransactions(user.id)).toHaveLength(10);
  });

  it("never lets concurrent debits push the balance negative", async () => {
    // Only ₹250 available but ₹500 of debits attempted simultaneously.
    const { user } = await createUserWithWallet({ balancePaise: 25_000 });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        applyWalletMutation({
          userId: user.id,
          amountPaise: 10_000,
          type: "PRODUCT_PURCHASE",
          idempotencyKey: `race-${i}`,
          description: `Order ${i}`,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly two ₹100 debits fit inside ₹250; the other three must fail.
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(3);

    const wallet = await db.query.wallets.findFirst({
      where: eq(wallets.userId, user.id),
    });
    expect(wallet?.balancePaise).toBe(5_000);
    expect(wallet!.balancePaise).toBeGreaterThanOrEqual(0);
  });

  it("keeps the ledger chain contiguous under concurrent writes", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        applyWalletMutation({
          userId: user.id,
          amountPaise: 1_000,
          type: "TOP_UP",
          idempotencyKey: `chain-${i}`,
          description: "top up",
        }),
      ),
    );

    const rows = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, user.id));

    // Every row's newBalance must appear as some other row's previousBalance,
    // forming an unbroken chain from 0 to the final balance.
    const sorted = rows.sort(
      (a, b) => a.previousBalancePaise - b.previousBalancePaise,
    );
    let expected = 0;
    for (const row of sorted) {
      expect(row.previousBalancePaise).toBe(expected);
      expect(row.newBalancePaise).toBe(expected + row.amountPaise);
      expected = row.newBalancePaise;
    }
    expect(expected).toBe(20_000);
  });
});

describe("validation", () => {
  it("rejects zero and negative amounts", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 10_000 });

    for (const amount of [0, -100]) {
      await expect(
        applyWalletMutation({
          userId: user.id,
          amountPaise: amount,
          type: "TOP_UP",
          idempotencyKey: `bad-${amount}`,
          description: "invalid",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("rejects fractional paise", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 10_000 });

    await expect(
      applyWalletMutation({
        userId: user.id,
        amountPaise: 100.5,
        type: "TOP_UP",
        idempotencyKey: "fractional",
        description: "invalid",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("creates a wallet on demand exactly once", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    await db.delete(wallets).where(eq(wallets.userId, user.id));

    const created = await Promise.all([
      getOrCreateWallet(user.id),
      getOrCreateWallet(user.id),
      getOrCreateWallet(user.id),
    ]);

    const ids = new Set(created.map((w) => w.id));
    expect(ids.size).toBe(1);
  });
});

describe("wallet settings (DEF-07)", () => {
  it("still allows changing the low-balance threshold", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    const updated = await updateWalletSettings(user.id, { lowBalanceThresholdPaise: 20_000 });
    expect(updated.lowBalanceThresholdPaise).toBe(20_000);
  });

  it("rejects enabling auto-recharge — nothing implements it yet, so it must not silently promise to", async () => {
    const { user } = await createUserWithWallet({ balancePaise: 0 });
    await expect(
      updateWalletSettings(user.id, {
        autoRechargeEnabled: true,
        autoRechargeTriggerPaise: 10_000,
        autoRechargeAmountPaise: 50_000,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
