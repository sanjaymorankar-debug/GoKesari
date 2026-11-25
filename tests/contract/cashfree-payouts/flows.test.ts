/**
 * Cashfree Payouts end to end against the real database, Cashfree stubbed
 * (fetch): the provider guard, a webhook that comes before createTransfer
 * returns, an unmatched event that is redelivered later, and the reconcile job
 * settling a transfer whose outcome was unknown (or sending it again with the
 * same transfer id when Cashfree never got it).
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return { ...actual, emailMode: () => "smtp" as const, sendEmail: vi.fn(async () => {}) };
});

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { notifications, payoutEvents, payoutItems, payoutWebhookParked } from "@/server/db/schema";
import { approvePayoutBatch, executePayoutBatch, handlePayoutWebhook } from "@/server/payouts/batches";
import { closePayoutCycle } from "@/server/payouts/cycle";
import { cashfreePayoutSignature, cashfreeTransferId } from "@/server/payouts/providers/cashfree";
import { reconcilePayouts } from "@/server/payouts/reconcile";
import { setCommissionRate } from "@/server/services/finance";
import { setRule } from "@/server/services/settings";
import { addDaysIso, deliveredOrder, gstShop, IST_TODAY, resetBatchE, rules, verifiedBank } from "../../helpers/batch-e";
import { createUser, resetDatabase } from "../../helpers/fixtures";
import * as fx from "./fixtures";

const env = getEnv() as unknown as Record<string, unknown>;
const KEYS = ["CASHFREE_PAYOUT_CLIENT_ID", "CASHFREE_PAYOUT_CLIENT_SECRET", "CASHFREE_PAYOUT_ENV", "CASHFREE_PAYOUTS_CONTRACT_VERIFIED"] as const;
const SECRET = "cf_flow_secret";
let saved: Record<string, unknown> = {};
let admin = { id: "", role: "ADMIN" as const };
let checker = { id: "", role: "ADMIN" as const };
const today = IST_TODAY();

/** What the stubbed Cashfree does with a POST (create) and a GET (status). */
const cashfree = {
  create: async (body: Record<string, unknown>): Promise<{ status?: number; body: unknown }> => ({ body: { ...fx.createAccepted, transfer_id: body.transfer_id } }),
  status: async (transferId: string): Promise<{ status?: number; body: unknown }> => ({ status: 404, body: { ...fx.statusNotFound, transfer_id: transferId } }),
  posts: [] as Record<string, unknown>[],
};

function signedWebhook(body: unknown): { raw: string; headers: Headers } {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  return { raw, headers: new Headers({ "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature": cashfreePayoutSignature(ts, raw, SECRET) }) };
}

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
  Object.assign(env, { CASHFREE_PAYOUT_CLIENT_ID: "CF_FLOW", CASHFREE_PAYOUT_CLIENT_SECRET: SECRET, CASHFREE_PAYOUT_ENV: "sandbox", CASHFREE_PAYOUTS_CONTRACT_VERIFIED: "true" });
  cashfree.posts = [];
  cashfree.create = async () => ({ body: fx.createAccepted });
  cashfree.status = async () => ({ status: 404, body: fx.statusNotFound });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const answer =
        init.method === "POST"
          ? await (async () => {
              const body = JSON.parse(String(init.body)) as Record<string, unknown>;
              cashfree.posts.push(body);
              return cashfree.create(body);
            })()
          : await cashfree.status(new URL(url).searchParams.get("transfer_id") ?? "");
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }),
  );
  await resetDatabase();
  await resetBatchE();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  checker = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setCommissionRate({ scope: "DEFAULT", rateBp: 1000 }, admin);
  await rules(admin, {
    invoicing: { enabled: true },
    payouts: { enabled: true, anchorDate: addDaysIso(today, -10), cycleDays: 5, holdDays: 0, provider: "CASHFREE", minPayoutPaise: 100 },
  });
});

afterEach(() => {
  Object.assign(env, saved);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await resetBatchE();
});

/** One shop with a verified account and a delivered order; the cycle closed and its batch approved. */
async function approvedBatch(): Promise<string> {
  const s = await gstShop({});
  await verifiedBank(s.owner.id, s.shop.id, "VERIFIED", "BANK_ACCOUNT");
  await deliveredOrder(admin, [[s.milkSp.id, 4]], { deliveredDaysAgo: 3 });
  const result = await closePayoutCycle({ today, actor: admin });
  await approvePayoutBatch(result!.batch!.id, checker);
  return result!.batch!.id;
}

describe("provider guard", () => {
  it("CASHFREE cannot be chosen, and does not send, until the contract is verified", async () => {
    env.CASHFREE_PAYOUTS_CONTRACT_VERIFIED = undefined;
    await expect(setRule("payouts", { provider: "CASHFREE" }, admin)).rejects.toThrow(/Cashfree Payouts cannot be chosen yet/);
    await expect(setRule("riderPayouts", { provider: "CASHFREE" }, admin)).rejects.toThrow(/Cashfree Payouts cannot be chosen yet/);
    await expect(setRule("dealerAutoPayout", { provider: "CASHFREE" }, admin)).rejects.toThrow(/Cashfree Payouts cannot be chosen yet/);
    // The rule saved earlier (while verified) still says CASHFREE: nothing is sent.
    env.CASHFREE_PAYOUTS_CONTRACT_VERIFIED = "true";
    const batchId = await approvedBatch();
    env.CASHFREE_PAYOUTS_CONTRACT_VERIFIED = undefined;
    await expect(executePayoutBatch(batchId, admin)).rejects.toThrow(/not yet verified/);
    expect(cashfree.posts).toHaveLength(0);
  });
});

describe("webhook matching", () => {
  it("a webhook that arrives before createTransfer returns settles the item (matched by the saved transfer id)", async () => {
    const batchId = await approvedBatch();
    const answers: number[] = [];
    cashfree.create = async (body) => {
      // Cashfree pays at once and its webhook reaches us before the API call has returned.
      const hook = signedWebhook(fx.transferWebhook("TRANSFER_SUCCESS", { transfer_id: body.transfer_id, cf_transfer_id: "cf-early-1", transfer_utr: "IMPS000000000001" }));
      answers.push((await handlePayoutWebhook("cashfree", hook.raw, hook.headers)).status);
      return { body: { ...fx.createAccepted, transfer_id: body.transfer_id, cf_transfer_id: "cf-early-1" } };
    };
    const { items, batch } = await executePayoutBatch(batchId, admin);
    expect(answers).toEqual([200]);
    expect(items[0]).toMatchObject({ status: "PAID", utr: "IMPS000000000001", providerRef: "cf-early-1", provider: "CASHFREE" });
    expect(items[0].providerTransferId).toBe(cashfree.posts[0].transfer_id);
    expect(items[0].providerTransferId).toBe(cashfreeTransferId(`${items[0].idempotencyKey}:1`));
    expect(batch.status).toBe("COMPLETED");
    expect(await db.select().from(payoutEvents).where(and(eq(payoutEvents.itemId, items[0].id), eq(payoutEvents.type, "WEBHOOK_SUCCESS")))).toHaveLength(1);
  });

  it("an event that matches nothing is parked and answered 409, not recorded; its redelivery is applied once", async () => {
    const batchId = await approvedBatch();
    // Cashfree cannot be reached: the outcome is unknown, the item stays PROCESSING.
    cashfree.create = async () => {
      throw new Error("timeout");
    };
    const { items } = await executePayoutBatch(batchId, admin);
    expect(items[0]).toMatchObject({ status: "PROCESSING" });
    expect(items[0].failureReason).toMatch(/Outcome unknown/);

    const stray = signedWebhook(fx.transferWebhook("TRANSFER_SUCCESS", { transfer_id: "gk_not_ours", cf_transfer_id: "cf-x", transfer_utr: "IMPS000000000002" }));
    const first = await handlePayoutWebhook("cashfree", stray.raw, stray.headers);
    expect(first.status).toBe(409);
    const again = await handlePayoutWebhook("cashfree", stray.raw, stray.headers);
    expect(again.status).toBe(409); // not swallowed as a "duplicate"
    expect(await db.select().from(payoutEvents).where(eq(payoutEvents.eventId, "cf-x:TRANSFER_SUCCESS"))).toHaveLength(0);
    const [parked] = await db.select().from(payoutWebhookParked).where(eq(payoutWebhookParked.eventId, "cf-x:TRANSFER_SUCCESS"));
    expect(parked).toMatchObject({ deliveries: 2, matchedAt: null });

    // The real event for our item: matched by its transfer id, applied once, redelivery acknowledged.
    const ours = signedWebhook(fx.transferWebhook("TRANSFER_SUCCESS", { transfer_id: items[0].providerTransferId, cf_transfer_id: "cf-ours", transfer_utr: "IMPS000000000003" }));
    expect((await handlePayoutWebhook("cashfree", ours.raw, ours.headers)).status).toBe(200);
    const redelivered = await handlePayoutWebhook("cashfree", ours.raw, ours.headers);
    expect(redelivered).toMatchObject({ status: 200, body: { duplicate: true } });
    const [paid] = await db.select().from(payoutItems).where(eq(payoutItems.id, items[0].id));
    expect(paid).toMatchObject({ status: "PAID", utr: "IMPS000000000003", providerRef: "cf-ours" });
    expect(await db.select().from(payoutEvents).where(eq(payoutEvents.eventId, "cf-ours:TRANSFER_SUCCESS"))).toHaveLength(1);
  });

  it("a parked event is applied once its payout exists (redelivery or the reconcile job)", async () => {
    const batchId = await approvedBatch();
    cashfree.create = async () => {
      throw new Error("timeout");
    };
    const { items } = await executePayoutBatch(batchId, admin);
    const transferId = items[0].providerTransferId!;
    // Pretend the event came while the row did not carry its transfer id yet.
    await db.update(payoutItems).set({ providerTransferId: null }).where(eq(payoutItems.id, items[0].id));
    const hook = signedWebhook(fx.transferWebhook("TRANSFER_FAILED", { transfer_id: transferId, cf_transfer_id: "cf-late", status_description: "Account closed" }));
    expect((await handlePayoutWebhook("cashfree", hook.raw, hook.headers)).status).toBe(409);
    await db.update(payoutItems).set({ providerTransferId: transferId }).where(eq(payoutItems.id, items[0].id));
    const summary = await reconcilePayouts();
    expect(summary.parkedReplayed).toBe(1);
    const [failed] = await db.select().from(payoutItems).where(eq(payoutItems.id, items[0].id));
    expect(failed).toMatchObject({ status: "FAILED", failureReason: "Account closed" });
    const [parked] = await db.select().from(payoutWebhookParked).where(eq(payoutWebhookParked.eventId, "cf-late:TRANSFER_FAILED"));
    expect(parked.matchedAt).not.toBeNull();
  });

  it("a stale or forged webhook is refused; LOW_BALANCE_ALERT alerts the administrators once", async () => {
    const hook = signedWebhook(fx.transferWebhook("TRANSFER_SUCCESS"));
    const ts = String(Date.now() - 10 * 60_000);
    const stale = new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": cashfreePayoutSignature(ts, hook.raw, SECRET) });
    expect((await handlePayoutWebhook("cashfree", hook.raw, stale)).status).toBe(401);
    expect((await handlePayoutWebhook("cashfree", hook.raw.replace("gk_test_1", "gk_test_2"), hook.headers)).status).toBe(401);

    const low = signedWebhook(fx.lowBalanceWebhook(1500));
    expect((await handlePayoutWebhook("cashfree", low.raw, low.headers)).status).toBe(200);
    expect((await handlePayoutWebhook("cashfree", low.raw, low.headers)).body).toMatchObject({ duplicate: true });
    const alerts = await db.select().from(notifications).where(eq(notifications.type, "support.payout_low_balance"));
    expect(alerts.map((a) => a.userId).sort()).toEqual([admin.id, checker.id].sort());
    expect(alerts[0].body).toContain("₹1500");
  });
});

describe("reconcile", () => {
  async function unknownItem() {
    const batchId = await approvedBatch();
    cashfree.create = async () => ({ status: 502, body: {} });
    const { items } = await executePayoutBatch(batchId, admin);
    expect(items[0]).toMatchObject({ status: "PROCESSING" });
    await db.update(payoutItems).set({ updatedAt: sql`now() - interval '31 minutes'` }).where(eq(payoutItems.id, items[0].id));
    return items[0];
  }

  it("settles an item whose outcome was unknown from Cashfree's status (by our transfer id)", async () => {
    const item = await unknownItem();
    const looked: string[] = [];
    cashfree.status = async (transferId) => {
      looked.push(transferId);
      return { body: { ...fx.statusSuccess, transfer_id: transferId, cf_transfer_id: "cf-rec-1", transfer_utr: "IMPS000000000004" } };
    };
    const summary = await reconcilePayouts();
    expect(summary).toMatchObject({ checked: 1, settled: 1, errors: [] });
    expect(looked).toEqual([item.providerTransferId]);
    const [paid] = await db.select().from(payoutItems).where(eq(payoutItems.id, item.id));
    expect(paid).toMatchObject({ status: "PAID", utr: "IMPS000000000004", providerRef: "cf-rec-1" });
    // Nothing is in flight any more: the next run checks nothing.
    expect((await reconcilePayouts()).checked).toBe(0);
  });

  it("an item checked less than 30 minutes ago is left alone", async () => {
    const item = await unknownItem();
    await db.update(payoutItems).set({ updatedAt: new Date() }).where(eq(payoutItems.id, item.id));
    expect((await reconcilePayouts()).checked).toBe(0);
  });

  it("NOT_FOUND: the same attempt is sent again with the same transfer id", async () => {
    const item = await unknownItem();
    cashfree.create = async (body) => ({ body: { ...fx.createAccepted, transfer_id: body.transfer_id, cf_transfer_id: "cf-resent" } });
    const summary = await reconcilePayouts();
    expect(summary).toMatchObject({ checked: 1, resent: 1 });
    expect(cashfree.posts.map((p) => p.transfer_id)).toEqual([item.providerTransferId, item.providerTransferId]);
    const [after] = await db.select().from(payoutItems).where(eq(payoutItems.id, item.id));
    expect(after).toMatchObject({ status: "PROCESSING", attempts: 1, providerRef: "cf-resent", providerTransferId: item.providerTransferId });
  });
});
