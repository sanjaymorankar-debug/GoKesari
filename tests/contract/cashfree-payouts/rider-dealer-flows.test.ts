/**
 * Cashfree Payouts for rider bank transfers and dealer commission payouts,
 * against the real database with Cashfree stubbed (fetch): the transfer id is
 * saved before sending, an early webhook settles the row, and the reconcile job
 * settles a transfer whose outcome was unknown.
 */
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return { ...actual, emailMode: () => "smtp" as const, sendEmail: vi.fn(async () => {}) };
});

import { getEnv } from "@/lib/env";
import { encryptSecret } from "@/lib/pan-crypto";
import { RULES } from "@/server/config/rules";
import { db } from "@/server/db";
import { bankAccounts, dealerCommissionLedger, dealerCommissionMonths, dealerPayoutBatches, dealers, deliveryPartnerEarnings, riderBankTransfers } from "@/server/db/schema";
import { approvePayoutBatch } from "@/server/dealers/auto-payout";
import { createPayoutBatch } from "@/server/dealers/commission";
import { handlePayoutWebhook } from "@/server/payouts/batches";
import { cashfreePayoutSignature, cashfreeTransferId } from "@/server/payouts/providers/cashfree";
import { reconcilePayouts } from "@/server/payouts/reconcile";
import { claimIntoTransfer, payableAccount, sendTransfer } from "@/server/rider-wallet/transfers";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createDeliveryPartner, createUser, resetDatabase } from "../../helpers/fixtures";
import * as fx from "./fixtures";

const env = getEnv() as unknown as Record<string, unknown>;
const KEYS = ["CASHFREE_PAYOUT_CLIENT_ID", "CASHFREE_PAYOUT_CLIENT_SECRET", "CASHFREE_PAYOUT_ENV", "CASHFREE_PAYOUTS_CONTRACT_VERIFIED"] as const;
const SECRET = "cf_flow_secret";
let saved: Record<string, unknown> = {};
let admin: { id: string; role: "ADMIN" };
let admin2: { id: string; role: "ADMIN" };

const cashfree = {
  create: async (body: Record<string, unknown>): Promise<{ status?: number; body: unknown }> => ({ body: { ...fx.createAccepted, transfer_id: body.transfer_id } }),
  status: async (transferId: string): Promise<{ status?: number; body: unknown }> => ({ status: 404, body: { ...fx.statusNotFound, transfer_id: transferId } }),
};

function signedWebhook(body: unknown) {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  return { raw, headers: new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": cashfreePayoutSignature(ts, raw, SECRET) }) };
}

beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
  Object.assign(env, { CASHFREE_PAYOUT_CLIENT_ID: "CF_FLOW", CASHFREE_PAYOUT_CLIENT_SECRET: SECRET, CASHFREE_PAYOUT_ENV: "sandbox", CASHFREE_PAYOUTS_CONTRACT_VERIFIED: "true" });
  cashfree.create = async () => ({ body: fx.createAccepted });
  cashfree.status = async () => ({ status: 404, body: fx.statusNotFound });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const answer = init.method === "POST" ? await cashfree.create(JSON.parse(String(init.body))) : await cashfree.status(new URL(url).searchParams.get("transfer_id") ?? "");
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    }),
  );
  await resetDatabase();
  await db.delete(dealerCommissionLedger);
  await db.delete(dealerCommissionMonths);
  for (const key of ["dealerPayoutTds", "dealerPayouts", "dealerAutoPayout", "riderPayouts"]) await db.execute(sql`delete from platform_settings where key = ${key}`);
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  admin2 = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setRule("riderPayouts", { provider: "CASHFREE", sandboxAutoWebhook: false }, admin);
  await setRule("dealerAutoPayout", { ...RULES.dealerAutoPayout.defaults, enabled: true, provider: "CASHFREE" }, admin);
  clearRuleCache();
});

afterEach(() => {
  Object.assign(env, saved);
  vi.unstubAllGlobals();
});

/** A rider with a verified account, ₹500 earned, claimed into a PENDING withdrawal transfer. */
async function riderTransfer() {
  const user = await createUser({ role: "DELIVERY_PARTNER", name: "Asha Rider" });
  const partner = await createDeliveryPartner(user.id, { status: "APPROVED" });
  await db.insert(bankAccounts).values({
    userId: user.id,
    holderType: "CUSTOMER",
    method: "BANK_ACCOUNT",
    accountHolderName: "Asha Rider",
    accountNumberEncrypted: encryptSecret("123456789012"),
    accountNumberLast4: "9012",
    ifsc: "sbin0001234",
    status: "VERIFIED",
    verifiedAt: new Date(),
  });
  await db.insert(deliveryPartnerEarnings).values({ deliveryPartnerId: partner.id, returnPickupId: crypto.randomUUID(), basePaise: 50_000, distancePaise: 0, totalPaise: 50_000, createdAt: new Date(Date.now() - 86_400_000) });
  const account = (await payableAccount(user.id))!;
  const { getPayoutProvider } = await import("@/server/payouts/providers");
  const claimed = await db.transaction((tx) =>
    claimIntoTransfer(tx, {
      deliveryPartnerId: partner.id,
      userId: user.id,
      kind: "WITHDRAWAL",
      before: null,
      amountPaise: 50_000,
      check: () => {},
      feePaise: 0,
      account,
      provider: getPayoutProvider("CASHFREE")!,
      mode: "IMPS",
      runId: null,
      periodStart: "2026-11-01",
      periodEnd: "2026-11-23",
      actor: { id: user.id, role: "DELIVERY_PARTNER" },
    }),
  );
  return claimed!.transfer;
}

describe("rider bank transfers", () => {
  it("the transfer id is saved before sending; a webhook arriving before the API answer pays it", async () => {
    const t = await riderTransfer();
    const sent: Record<string, unknown>[] = [];
    cashfree.create = async (body) => {
      sent.push(body);
      const [row] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, t.id));
      expect(row.providerTransferId).toBe(body.transfer_id);
      const hook = signedWebhook(fx.transferWebhook("TRANSFER_SUCCESS", { transfer_id: body.transfer_id, cf_transfer_id: "cf-r-1", transfer_utr: "IMPS000000000011" }));
      expect((await handlePayoutWebhook("cashfree", hook.raw, hook.headers)).status).toBe(200);
      return { body: { ...fx.createAccepted, transfer_id: body.transfer_id, cf_transfer_id: "cf-r-1" } };
    };
    const after = await sendTransfer(t.id);
    expect(sent[0].transfer_id).toBe(cashfreeTransferId(`rider-transfer:${t.id}:1`));
    expect((sent[0].beneficiary_details as { beneficiary_instrument_details: { bank_ifsc: string } }).beneficiary_instrument_details.bank_ifsc).toBe("SBIN0001234");
    expect(after).toMatchObject({ status: "SUCCESS", utr: "IMPS000000000011", providerRef: "cf-r-1" });
  });

  it("outcome unknown (5xx) waits for review; the reconcile job settles it from Cashfree's status", async () => {
    const t = await riderTransfer();
    cashfree.create = async () => ({ status: 503, body: {} });
    const unknown = await sendTransfer(t.id);
    expect(unknown).toMatchObject({ status: "FAILED", needsReview: true });
    expect(unknown.failureReason).toMatch(/^Outcome unknown/);
    cashfree.status = async (transferId) => ({ body: { ...fx.statusSuccess, transfer_id: transferId, cf_transfer_id: "cf-r-2", transfer_utr: "IMPS000000000012" } });
    const summary = await reconcilePayouts();
    expect(summary).toMatchObject({ checked: 1, settled: 1, errors: [] });
    const [row] = await db.select().from(riderBankTransfers).where(eq(riderBankTransfers.id, t.id));
    expect(row).toMatchObject({ status: "SUCCESS", utr: "IMPS000000000012", needsReview: false, providerRef: "cf-r-2" });
  });

  it("a definite refusal (4xx) releases a withdrawal at once instead of waiting for review", async () => {
    const t = await riderTransfer();
    cashfree.create = async () => ({ status: 400, body: fx.createError });
    const after = await sendTransfer(t.id);
    expect(after).toMatchObject({ status: "RELEASED", needsReview: false });
  });
});

describe("dealer commission payouts", () => {
  async function approved() {
    const user = await createUser({ role: "DEALER" });
    const [d] = await db
      .insert(dealers)
      .values({ userId: user.id, legalName: "Dealer One", contactName: "D", dealerType: "PROPRIETORSHIP", status: "APPROVED", panHash: `pan-${user.id}`, panLast4: "234F", bankStatus: "VERIFIED", bankAccountEnc: encryptSecret("123456789012"), bankIfsc: "SBIN0001234", bankHolderName: "Dealer One" })
      .returning();
    await db.insert(dealerCommissionLedger).values({ dealerId: d.id, payeeMemberId: null, milestone: "MONTHLY", entryType: "BONUS", accrualKey: `T:${d.id}`, amountPaise: 30_000, basePaise: 30_000, status: "APPROVED", createdAt: new Date(Date.now() - 60_000) });
    return createPayoutBatch(d.id, admin);
  }

  it("an early webhook (matched by the saved transfer id) pays it", async () => {
    const batch = await approved();
    cashfree.create = async (body) => {
      const hook = signedWebhook(fx.transferWebhook("TRANSFER_SUCCESS", { transfer_id: body.transfer_id, cf_transfer_id: "cf-d-1", transfer_utr: "NEFT000000000021" }));
      expect((await handlePayoutWebhook("cashfree", hook.raw, hook.headers)).status).toBe(200);
      return { body: { ...fx.createAccepted, transfer_id: body.transfer_id, cf_transfer_id: "cf-d-1" } };
    };
    const paid = await approvePayoutBatch(batch.id, admin2);
    expect(paid).toMatchObject({ status: "PAID", paymentReference: "NEFT000000000021", providerTransferId: cashfreeTransferId(`dealer-payout:${batch.id}:1`) });
  });

  it("outcome unknown is settled by the reconcile job; a definite failure afterwards schedules a retry", async () => {
    const batch = await approved();
    cashfree.create = async () => {
      throw new Error("socket hang up");
    };
    const unknown = await approvePayoutBatch(batch.id, admin2);
    expect(unknown).toMatchObject({ status: "FAILED", needsReview: true });
    cashfree.status = async (transferId) => ({ body: { ...fx.createAccepted, transfer_id: transferId, status: "FAILED", status_description: "Invalid account" } });
    const summary = await reconcilePayouts();
    expect(summary).toMatchObject({ checked: 1, settled: 1 });
    const [row] = await db.select().from(dealerPayoutBatches).where(eq(dealerPayoutBatches.id, batch.id));
    expect(row).toMatchObject({ status: "FAILED", needsReview: false, failureReason: "Invalid account" });
    expect(row.nextRetryAt).not.toBeNull();
  });
});
