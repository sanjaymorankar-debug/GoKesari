/**
 * Cashfree Payouts V2 adapter: request body and headers, status mapping,
 * transfer ids, webhook signature and freshness, and parsing of each webhook
 * type. No network: fetch is stubbed with the shapes in ./fixtures.
 */
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getEnv } from "@/lib/env";
import {
  cashfreePayoutHeaders,
  cashfreePayoutProvider,
  cashfreePayoutSignature,
  cashfreeTransferBody,
  cashfreeTransferId,
  cashfreeTransferStatus,
  cleanBeneficiaryName,
  cleanRemarks,
  rupeesFromPaise,
  webhookIsFresh,
} from "@/server/payouts/providers/cashfree";
import { PayoutProviderError, type TransferRequest } from "@/server/payouts/types";
import * as fx from "./fixtures";

const env = getEnv() as unknown as Record<string, unknown>;
const KEYS = ["CASHFREE_PAYOUT_CLIENT_ID", "CASHFREE_PAYOUT_CLIENT_SECRET", "CASHFREE_PAYOUT_ENV", "CASHFREE_PAYOUT_PUBLIC_KEY"] as const;
let saved: Record<string, unknown> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
  Object.assign(env, { CASHFREE_PAYOUT_CLIENT_ID: "CF_TEST_CLIENT", CASHFREE_PAYOUT_CLIENT_SECRET: "cf_test_secret", CASHFREE_PAYOUT_ENV: "sandbox", CASHFREE_PAYOUT_PUBLIC_KEY: undefined });
});
afterEach(() => {
  Object.assign(env, saved);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the request body is checked field by field
type Body = Record<string, any>;

const request = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  idempotencyKey: "payout-item:3f1c9a52-7d1e-4f63-9b70-2b8e4f0c1d2a:11111111-2222-4333-8444-555555555555:1",
  referenceId: "11111111-2222-4333-8444-555555555555",
  amountPaise: 12345,
  mode: "IMPS",
  beneficiary: { name: "Shri Ganesh Kirana & Sons (Pune)", method: "BANK_ACCOUNT", accountNumber: " 1234 5678 9012 ", ifsc: " sbin0001234 " },
  narration: "GoKesari payout #3f1c9a52 – Nov/2026",
  attempt: 1,
  ...over,
});

function stubFetch(...answers: { status?: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const a = answers[Math.min(i++, answers.length - 1)];
      return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: a.headers });
    }),
  );
  return calls;
}

describe("request body", () => {
  it("cleans the name and remarks, uppercases the IFSC, sends rupees with 2 decimals and our transfer id", () => {
    const body = cashfreeTransferBody(request()) as Body;
    expect(body).toMatchObject({
      transfer_id: cashfreeTransferId(request().idempotencyKey),
      transfer_amount: 123.45,
      transfer_currency: "INR",
      transfer_mode: "imps",
      transfer_remarks: "GoKesari payout 3f1c9a52 Nov 2026",
      beneficiary_details: {
        beneficiary_name: "Shri Ganesh Kirana Sons Pune",
        beneficiary_instrument_details: { bank_account_number: "123456789012", bank_ifsc: "SBIN0001234" },
      },
    });
    expect(body.transfer_remarks).toMatch(/^[A-Za-z0-9 ]{1,70}$/);
  });

  it("UPI transfers carry the VPA; long remarks are cut to 70; odd names never come out empty", () => {
    const body = cashfreeTransferBody(request({ mode: "UPI", beneficiary: { name: "राम", method: "UPI", upiId: " rider@okaxis " }, narration: "x".repeat(200) })) as Body;
    expect(body.transfer_mode).toBe("upi");
    expect(body.beneficiary_details.beneficiary_instrument_details).toEqual({ vpa: "rider@okaxis" });
    expect(body.transfer_remarks).toHaveLength(70);
    expect(body.beneficiary_details.beneficiary_name).toBe("GoKesari Payee");
    expect(cleanBeneficiaryName("Ramesh  Patil.")).toBe("Ramesh Patil");
    expect(cleanRemarks("  ")).toBe("");
  });

  it("rounds to paise", () => {
    expect(rupeesFromPaise(1)).toBe(0.01);
    expect(rupeesFromPaise(10_000_00)).toBe(10000);
    expect(rupeesFromPaise(12345.4)).toBe(123.45);
  });
});

describe("headers", () => {
  it("send the payout keys and API version, and no 2FA signature without the public key", () => {
    const h = cashfreePayoutHeaders("req-1");
    expect(h).toMatchObject({ "x-client-id": "CF_TEST_CLIENT", "x-client-secret": "cf_test_secret", "x-api-version": "2024-01-01", "x-request-id": "req-1" });
    expect(h["x-cf-signature"]).toBeUndefined();
  });

  it("add X-Cf-Signature: RSA-OAEP of '<client id>.<unix seconds>' with the 2FA public key (one-line PEM accepted)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    env.CASHFREE_PAYOUT_PUBLIC_KEY = pem.replace(/\n/g, "\\n");
    const now = Date.UTC(2026, 10, 23, 18, 0, 0);
    const h = cashfreePayoutHeaders("req-1", now);
    const plain = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(h["x-cf-signature"], "base64")).toString();
    expect(plain).toBe(`CF_TEST_CLIENT.${now / 1000}`);
  });
});

describe("status mapping", () => {
  it.each([
    ["SUCCESS", "SUCCESS"],
    ["COMPLETED", "SUCCESS"],
    ["FAILED", "FAILED"],
    ["REJECTED", "FAILED"],
    ["MANUALLY_REJECTED", "FAILED"],
    ["REVERSED", "REVERSED"],
    ["RECEIVED", "PROCESSING"],
    ["APPROVAL_PENDING", "PROCESSING"],
    ["PENDING", "PROCESSING"],
    ["QUEUED", "PROCESSING"],
    ["SCHEDULED", "PROCESSING"],
    ["SOMETHING_NEW", "PROCESSING"],
    [undefined, "PROCESSING"],
  ])("%s → %s", (given, expected) => {
    expect(cashfreeTransferStatus(given)).toBe(expected);
  });
});

describe("transfer id", () => {
  it("is at most 40 of [A-Za-z0-9_], one per key, and unique across shops, attempts, riders and dealers", () => {
    const ids = new Set<string>();
    const keys: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const uuid = `${String(i).padStart(8, "0")}-2222-4333-8444-555555555555`;
      keys.push(`payout-item:3f1c9a52-7d1e-4f63-9b70-2b8e4f0c1d2a:${uuid}:1`, `payout-item:3f1c9a52-7d1e-4f63-9b70-2b8e4f0c1d2a:${uuid}:2`, `rider-transfer:${uuid}:1`, `dealer-payout:${uuid}:1`);
    }
    for (const key of keys) {
      const id = cashfreeTransferId(key);
      expect(id).toMatch(/^[A-Za-z0-9_]{1,40}$/);
      expect(cashfreeTransferId(key)).toBe(id);
      ids.add(id);
    }
    expect(ids.size).toBe(keys.length);
    expect(cashfreePayoutProvider.transferIdFor("rider-transfer:abc:1")).toBe(cashfreeTransferId("rider-transfer:abc:1"));
  });
});

describe("createTransfer", () => {
  it("accepted → PROCESSING with Cashfree's reference; success with a UTR → SUCCESS", async () => {
    const calls = stubFetch({ body: fx.createAccepted });
    await expect(cashfreePayoutProvider.createTransfer(request())).resolves.toEqual({ status: "PROCESSING", providerRef: "1588542", utr: null, failureReason: null });
    expect(calls[0].url).toBe("https://sandbox.cashfree.com/payout/transfers");
    expect(calls[0].init.method).toBe("POST");
    stubFetch({ body: fx.createSuccess });
    await expect(cashfreePayoutProvider.createTransfer(request())).resolves.toMatchObject({ status: "SUCCESS", utr: "IMPS1234567890" });
  });

  it("HTTP 429 is sent again with the same transfer id, then left as retryable (outcome for the reconcile job)", async () => {
    const calls = stubFetch({ status: 429, body: { message: "Too many requests" }, headers: { "retry-after": "0" } }, { body: fx.createAccepted });
    await expect(cashfreePayoutProvider.createTransfer(request())).resolves.toMatchObject({ status: "PROCESSING" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0].init.body)).transfer_id).toBe(JSON.parse(String(calls[1].init.body)).transfer_id);

    const again = stubFetch({ status: 429, body: {}, headers: { "retry-after": "0" } });
    const error = await cashfreePayoutProvider.createTransfer(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayoutProviderError);
    expect((error as PayoutProviderError).retryable).toBe(true);
    expect(again).toHaveLength(3);
  });

  it("5xx is retryable (outcome unknown); a 4xx refusal and insufficient balance are definite", async () => {
    stubFetch({ status: 502, body: {} });
    await expect(cashfreePayoutProvider.createTransfer(request())).rejects.toMatchObject({ retryable: true });
    stubFetch({ status: 400, body: fx.createError });
    await expect(cashfreePayoutProvider.createTransfer(request())).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/bank_ifsc/) });
    stubFetch({ status: 400, body: fx.insufficientBalance });
    await expect(cashfreePayoutProvider.createTransfer(request())).rejects.toMatchObject({ retryable: false });
  });

  it("a network error is retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("socket hang up"))));
    await expect(cashfreePayoutProvider.createTransfer(request())).rejects.toMatchObject({ retryable: true, message: expect.stringMatching(/unreachable/) });
  });

  it("a duplicate transfer id (a resend of an attempt Cashfree has) returns that transfer's state", async () => {
    const calls = stubFetch({ status: 409, body: fx.createDuplicate }, { body: fx.statusSuccess });
    await expect(cashfreePayoutProvider.createTransfer(request())).resolves.toMatchObject({ status: "SUCCESS", providerRef: "1588542", utr: "IMPS1234567890" });
    expect(calls[1].init.method).toBe("GET");
    expect(calls[1].url).toBe(`https://sandbox.cashfree.com/payout/transfers?transfer_id=${cashfreeTransferId(request().idempotencyKey)}`);
  });

  it("refuses without keys", async () => {
    env.CASHFREE_PAYOUT_CLIENT_SECRET = undefined;
    await expect(cashfreePayoutProvider.createTransfer(request())).rejects.toMatchObject({ retryable: false });
  });
});

describe("getTransfer", () => {
  it("maps the status, UTR and reference; 404 is NOT_FOUND; 5xx throws retryable", async () => {
    stubFetch({ body: fx.statusSuccess });
    await expect(cashfreePayoutProvider.getTransfer!("gk_test_1")).resolves.toEqual({ status: "SUCCESS", providerRef: "1588542", utr: "IMPS1234567890", failureReason: null });
    stubFetch({ body: { ...fx.createAccepted, status: "REVERSED", status_description: "Account closed" } });
    await expect(cashfreePayoutProvider.getTransfer!("gk_test_1")).resolves.toMatchObject({ status: "REVERSED", failureReason: "Account closed" });
    stubFetch({ status: 404, body: fx.statusNotFound });
    await expect(cashfreePayoutProvider.getTransfer!("gk_test_1")).resolves.toMatchObject({ status: "NOT_FOUND" });
    stubFetch({ status: 503, body: {} });
    await expect(cashfreePayoutProvider.getTransfer!("gk_test_1")).rejects.toMatchObject({ retryable: true });
  });
});

describe("webhook signature", () => {
  const raw = JSON.stringify(fx.transferWebhook("TRANSFER_SUCCESS", { transfer_utr: "IMPS1" }));
  const signed = (timestamp: string, body = raw) =>
    new Headers({ "x-webhook-timestamp": timestamp, "x-webhook-signature": cashfreePayoutSignature(timestamp, body, "cf_test_secret") });

  it("passes when signed with the client secret over timestamp + raw body, and fresh", () => {
    expect(cashfreePayoutProvider.verifyWebhook(raw, signed(String(Date.now())))).toBe(true);
    // Seconds are accepted too.
    expect(cashfreePayoutProvider.verifyWebhook(raw, signed(String(Math.floor(Date.now() / 1000))))).toBe(true);
  });

  it("fails when the body is tampered with, the signature is missing or made with another secret", () => {
    const ts = String(Date.now());
    expect(cashfreePayoutProvider.verifyWebhook(raw.replace("IMPS1", "IMPS2"), signed(ts))).toBe(false);
    expect(cashfreePayoutProvider.verifyWebhook(raw, new Headers({ "x-webhook-timestamp": ts }))).toBe(false);
    expect(cashfreePayoutProvider.verifyWebhook(raw, new Headers({ "x-webhook-timestamp": ts, "x-webhook-signature": cashfreePayoutSignature(ts, raw, "other") }))).toBe(false);
  });

  it("fails when the timestamp is more than 5 minutes old (or ahead)", () => {
    expect(cashfreePayoutProvider.verifyWebhook(raw, signed(String(Date.now() - 6 * 60_000)))).toBe(false);
    expect(cashfreePayoutProvider.verifyWebhook(raw, signed(String(Date.now() + 6 * 60_000)))).toBe(false);
    expect(webhookIsFresh(String(Date.now() - 4 * 60_000))).toBe(true);
    expect(webhookIsFresh("not a time")).toBe(false);
  });
});

describe("parseWebhook", () => {
  const parse = (body: unknown) => cashfreePayoutProvider.parseWebhook(JSON.stringify(body), new Headers());

  it("TRANSFER_SUCCESS: our transfer id, Cashfree's reference and the UTR", () => {
    expect(parse(fx.transferWebhook("TRANSFER_SUCCESS", { transfer_utr: "IMPS1234567890" }))).toMatchObject({
      eventId: "1588542:TRANSFER_SUCCESS",
      kind: "TRANSFER",
      status: "SUCCESS",
      providerRef: "1588542",
      transferId: "gk_test_1",
      referenceId: "gk_test_1",
      utr: "IMPS1234567890",
    });
  });

  it.each([
    ["TRANSFER_FAILED", "FAILED"],
    ["TRANSFER_REJECTED", "FAILED"],
    ["TRANSFER_REVERSED", "REVERSED"],
  ])("%s → %s with the reason", (type, status) => {
    expect(parse(fx.transferWebhook(type, { status_description: "Beneficiary account closed" }))).toMatchObject({ eventId: `1588542:${type}`, status, failureReason: "Beneficiary account closed" });
  });

  it("a transfer event of another type follows data.status (MANUALLY_REJECTED fails it)", () => {
    expect(parse(fx.transferWebhook("TRANSFER_ACKNOWLEDGED", { status: "MANUALLY_REJECTED" }))).toMatchObject({ kind: "TRANSFER", status: "FAILED" });
    expect(parse(fx.transferWebhook("TRANSFER_ACKNOWLEDGED", { status: "PENDING" }))).toMatchObject({ kind: "TRANSFER", status: "PROCESSING" });
  });

  it("LOW_BALANCE_ALERT and other notices: no payout, and each event its own id", () => {
    const a = parse(fx.lowBalanceWebhook(1500, "2026-11-23T10:00:00"));
    const b = parse(fx.lowBalanceWebhook(900, "2026-11-23T11:00:00"));
    expect(a).toMatchObject({ kind: "LOW_BALANCE", providerRef: null, transferId: null });
    expect(a.eventId).toMatch(/^LOW_BALANCE_ALERT:[0-9a-f]{32}$/);
    expect(b.eventId).not.toBe(a.eventId);
    // The same event delivered twice keeps its id.
    expect(parse(fx.lowBalanceWebhook(1500, "2026-11-23T10:00:00")).eventId).toBe(a.eventId);
    expect(parse({ type: "BENEFICIARY_INCIDENT", data: { bank: "SBIN" } })).toMatchObject({ kind: "OTHER" });
  });
});
