/**
 * Cashfree Payouts V2 contract, live against Cashfree's sandbox. Skipped unless
 * CASHFREE_PAYOUTS_LIVE=1 — run by .github/workflows/cashfree-payouts-sandbox.yml
 * (workflow_dispatch and weekly) with the sandbox keys from the repository
 * secrets CF_PAYOUT_SANDBOX_CLIENT_ID / CF_PAYOUT_SANDBOX_SECRET (and, because
 * GitHub's runners have no fixed IP, the 2FA key CF_PAYOUT_SANDBOX_PUBLIC_KEY).
 *
 * Checks the adapter's request and the fields it reads: create, a resend with
 * the same transfer id, the status lookup (known and unknown ids) and a refused
 * request. Every request and response (keys removed) is written to
 * CASHFREE_PAYOUTS_RECORD_DIR for the run's artifact. Webhooks cannot reach a
 * runner: they are checked on test.gokesari.com with the sandbox keys.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getEnv } from "@/lib/env";
import { cashfreePayoutProvider, cashfreeTransferId } from "@/server/payouts/providers/cashfree";
import type { TransferRequest } from "@/server/payouts/types";

const live = process.env.CASHFREE_PAYOUTS_LIVE === "1";
const recordDir = process.env.CASHFREE_PAYOUTS_RECORD_DIR;
const env = getEnv() as unknown as Record<string, unknown>;
const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const records: unknown[] = [];
const realFetch = globalThis.fetch;

// Cashfree's sandbox test beneficiaries (override from the workflow if Cashfree changes them).
const BANK_ACCOUNT = process.env.CF_PAYOUT_SANDBOX_TEST_ACCOUNT ?? "026291800001191";
const BANK_IFSC = process.env.CF_PAYOUT_SANDBOX_TEST_IFSC ?? "YESB0000262";
const UPI_ID = process.env.CF_PAYOUT_SANDBOX_TEST_VPA ?? "success@upi";

const request = (suffix: string, over: Partial<TransferRequest> = {}): TransferRequest => ({
  idempotencyKey: `contract-${run}-${suffix}`,
  referenceId: `contract-${run}-${suffix}`,
  amountPaise: 100,
  mode: "IMPS",
  beneficiary: { name: "GoKesari Contract Test", method: "BANK_ACCOUNT", accountNumber: BANK_ACCOUNT, ifsc: BANK_IFSC },
  narration: "GoKesari contract test",
  attempt: 1,
  ...over,
});

describe.skipIf(!live)("Cashfree Payouts sandbox (live)", () => {
  beforeAll(() => {
    Object.assign(env, {
      CASHFREE_PAYOUT_CLIENT_ID: process.env.CF_PAYOUT_SANDBOX_CLIENT_ID,
      CASHFREE_PAYOUT_CLIENT_SECRET: process.env.CF_PAYOUT_SANDBOX_SECRET,
      CASHFREE_PAYOUT_PUBLIC_KEY: process.env.CF_PAYOUT_SANDBOX_PUBLIC_KEY || undefined,
      CASHFREE_PAYOUT_ENV: "sandbox",
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      const text = await response.clone().text();
      records.push({ method: init?.method ?? "GET", url: String(input), request: init?.body ? JSON.parse(String(init.body)) : null, status: response.status, response: text });
      return response;
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (recordDir) {
      mkdirSync(recordDir, { recursive: true });
      writeFileSync(join(recordDir, `cashfree-payouts-${run}.json`), JSON.stringify(records, null, 2));
    }
  });

  it("is configured with the sandbox keys", () => {
    expect(cashfreePayoutProvider.isConfigured()).toBe(true);
  });

  it("creates a bank transfer; a resend with the same transfer id returns the same transfer; the status lookup finds it", async () => {
    const created = await cashfreePayoutProvider.createTransfer(request("bank"));
    expect(created.providerRef).toBeTruthy();
    expect(["PROCESSING", "SUCCESS"]).toContain(created.status);

    const again = await cashfreePayoutProvider.createTransfer(request("bank"));
    expect(again.providerRef).toBe(created.providerRef);

    let status = await cashfreePayoutProvider.getTransfer!(cashfreeTransferId(request("bank").idempotencyKey));
    for (let i = 0; i < 12 && status.status === "PROCESSING"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      status = await cashfreePayoutProvider.getTransfer!(cashfreeTransferId(request("bank").idempotencyKey));
    }
    expect(status.providerRef).toBe(created.providerRef);
    expect(status.status).toBe("SUCCESS");
    expect(status.utr).toBeTruthy();
  }, 120_000);

  it("creates a UPI transfer", async () => {
    const created = await cashfreePayoutProvider.createTransfer(request("upi", { mode: "UPI", beneficiary: { name: "GoKesari Contract Test", method: "UPI", upiId: UPI_ID } }));
    expect(created.providerRef).toBeTruthy();
  }, 60_000);

  it("an unknown transfer id is NOT_FOUND", async () => {
    await expect(cashfreePayoutProvider.getTransfer!(`gk_missing_${run}`)).resolves.toMatchObject({ status: "NOT_FOUND" });
  });

  it("an invalid IFSC is a definite refusal", async () => {
    await expect(cashfreePayoutProvider.createTransfer(request("bad", { beneficiary: { name: "GoKesari Contract Test", method: "BANK_ACCOUNT", accountNumber: BANK_ACCOUNT, ifsc: "XXXX0" } }))).rejects.toMatchObject({ retryable: false });
  });
});
