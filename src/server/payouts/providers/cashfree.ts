/**
 * Cashfree Payouts (V2) adapter (batch-2026-10 WS-E; finished 23-Nov-2026).
 *
 * Configured by CASHFREE_PAYOUT_CLIENT_ID and CASHFREE_PAYOUT_CLIENT_SECRET
 * (Cashfree Payouts keys — not the payment-gateway CASHFREE_APP_ID /
 * CASHFREE_SECRET_KEY) and CASHFREE_PAYOUT_ENV (sandbox | production).
 * isConfigured() is false without both keys. Optional CASHFREE_PAYOUT_PUBLIC_KEY
 * turns on two-factor signing (X-Cf-Signature) instead of IP allow-listing.
 * No rule may send through it until CASHFREE_PAYOUTS_CONTRACT_VERIFIED=true
 * (src/server/payouts/guard.ts).
 *
 * The API, from Cashfree's Payouts V2 documentation (checked by the contract
 * tests in tests/contract/cashfree-payouts, run live against the sandbox by
 * .github/workflows/cashfree-payouts-sandbox.yml):
 *   - POST {base}/payout/transfers, headers x-client-id, x-client-secret,
 *     x-api-version 2024-01-01, x-request-id; body transfer_id (ours: the
 *     idempotency key, ≤ 40 of [A-Za-z0-9_]), transfer_amount (rupees, 2 dp),
 *     transfer_currency, transfer_mode, transfer_remarks (letters, digits and
 *     spaces, ≤ 70), beneficiary_details {beneficiary_name (letters and spaces),
 *     beneficiary_instrument_details {bank_account_number, bank_ifsc | vpa}}.
 *   - GET {base}/payout/transfers?transfer_id=… — the status lookup.
 *   - Statuses RECEIVED, APPROVAL_PENDING, PENDING, QUEUED, SCHEDULED (in
 *     progress), SUCCESS, FAILED, REJECTED, MANUALLY_REJECTED (failed),
 *     REVERSED (returned by the beneficiary bank).
 *   - Webhooks: TRANSFER_SUCCESS / TRANSFER_FAILED / TRANSFER_REJECTED /
 *     TRANSFER_REVERSED (and others) with data {transfer_id, cf_transfer_id,
 *     status, transfer_utr, status_description}; LOW_BALANCE_ALERT for the
 *     account. No event id is sent: a transfer event is identified by
 *     cf_transfer_id + type, any other event by a hash of its body.
 *   - Signature: `x-webhook-signature` = base64 HMAC-SHA256 of
 *     (x-webhook-timestamp + raw body) with the client secret. An event whose
 *     timestamp is more than WEBHOOK_MAX_AGE_MS away from now is refused.
 */
import { constants, createHash, createHmac, publicEncrypt, timingSafeEqual } from "node:crypto";

import { cashfreeEnvProblem, getEnv } from "@/lib/env";
import {
  PayoutProviderError,
  type PayoutProvider,
  type PayoutWebhookEvent,
  type TransferRequest,
  type TransferResult,
  type TransferStatus,
} from "../types";

export const CASHFREE_PAYOUT_API_VERSION = "2024-01-01";
/** A webhook older (or further in the future) than this is refused. */
export const WEBHOOK_MAX_AGE_MS = 5 * 60_000;
/** HTTP 429: tries in all (with the same transfer_id) before the outcome is left to the reconcile job. */
const RATE_LIMIT_TRIES = 3;

function base(): string {
  return getEnv().CASHFREE_PAYOUT_ENV === "production" ? "https://api.cashfree.com" : "https://sandbox.cashfree.com";
}

/**
 * Cashfree's transfer_id: letters, digits and _ only, at most 40 characters,
 * and unique per transfer (it is Cashfree's idempotency key). A key that fits
 * is sent as it is; a longer one becomes "gk" + 38 hex characters of its
 * SHA-256 — still one id per key, never the same for two keys
 * (docs/payments-cashfree-audit-2026-11: cutting "payout-item:<cycle>:<shop>:<n>"
 * to 40 characters gave every shop in a cycle the same transfer_id).
 */
export function cashfreeTransferId(idempotencyKey: string): string {
  const plain = idempotencyKey.replace(/[^A-Za-z0-9_]/g, "_");
  if (plain.length <= 40) return plain;
  return `gk${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 38)}`;
}

export function cashfreePayoutSignature(timestamp: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
}

/** Beneficiary name: letters and single spaces only, at most 100 characters. */
export function cleanBeneficiaryName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^A-Za-z ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100).trim();
  return cleaned || "GoKesari Payee";
}

/** Transfer remarks: letters, digits and single spaces only, at most 70 characters. */
export function cleanRemarks(text: string): string {
  return text.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 70).trim();
}

/** Rupees with at most 2 decimals, from integer paise. */
export function rupeesFromPaise(amountPaise: number): number {
  return Math.round(amountPaise) / 100;
}

/** Every Cashfree Payouts V2 transfer status, mapped to ours. Unknown ones count as still in progress. */
export function cashfreeTransferStatus(status: string | null | undefined): "SUCCESS" | "FAILED" | "REVERSED" | "PROCESSING" {
  switch ((status ?? "").toUpperCase()) {
    case "SUCCESS":
    case "COMPLETED":
      return "SUCCESS";
    case "FAILED":
    case "REJECTED":
    case "MANUALLY_REJECTED":
      return "FAILED";
    case "REVERSED":
      return "REVERSED";
    // RECEIVED, APPROVAL_PENDING, PENDING, QUEUED, SCHEDULED, SENT_TO_BENEFICIARY …
    default:
      return "PROCESSING";
  }
}

const WEBHOOK_TYPE_STATUS: Record<string, "SUCCESS" | "FAILED" | "REVERSED"> = {
  TRANSFER_SUCCESS: "SUCCESS",
  TRANSFER_FAILED: "FAILED",
  TRANSFER_REJECTED: "FAILED",
  TRANSFER_REVERSED: "REVERSED",
};

/** The two-factor header: RSA-OAEP (SHA-1) of "<client id>.<unix seconds>" with Cashfree's public key, base64. */
export function cashfreePayoutTwoFactorSignature(clientId: string, publicKeyPem: string, nowMs: number = Date.now()): string {
  const key = publicKeyPem.includes("\\n") ? publicKeyPem.replace(/\\n/g, "\n") : publicKeyPem;
  const plain = `${clientId}.${Math.floor(nowMs / 1000)}`;
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(plain)).toString("base64");
}

/** The request headers (with X-Cf-Signature when CASHFREE_PAYOUT_PUBLIC_KEY is set). */
export function cashfreePayoutHeaders(requestId: string, nowMs: number = Date.now()): Record<string, string> {
  const env = getEnv();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-client-id": env.CASHFREE_PAYOUT_CLIENT_ID ?? "",
    "x-client-secret": env.CASHFREE_PAYOUT_CLIENT_SECRET ?? "",
    "x-api-version": CASHFREE_PAYOUT_API_VERSION,
    "x-request-id": requestId.slice(0, 64),
  };
  if (env.CASHFREE_PAYOUT_PUBLIC_KEY && env.CASHFREE_PAYOUT_CLIENT_ID) {
    headers["x-cf-signature"] = cashfreePayoutTwoFactorSignature(env.CASHFREE_PAYOUT_CLIENT_ID, env.CASHFREE_PAYOUT_PUBLIC_KEY, nowMs);
  }
  return headers;
}

/** The JSON body of a transfer request. */
export function cashfreeTransferBody(request: TransferRequest): Record<string, unknown> {
  const b = request.beneficiary;
  const instrument =
    b.method === "UPI"
      ? { vpa: (b.upiId ?? "").trim() }
      : { bank_account_number: (b.accountNumber ?? "").replace(/\s+/g, ""), bank_ifsc: (b.ifsc ?? "").trim().toUpperCase() };
  return {
    transfer_id: cashfreeTransferId(request.idempotencyKey),
    transfer_amount: rupeesFromPaise(request.amountPaise),
    transfer_currency: "INR",
    transfer_mode: request.mode.toLowerCase(),
    transfer_remarks: cleanRemarks(request.narration) || "GoKesari payout",
    beneficiary_details: { beneficiary_name: cleanBeneficiaryName(b.name), beneficiary_instrument_details: instrument },
  };
}

/** Milliseconds since the epoch from x-webhook-timestamp (seconds, milliseconds or an ISO date). */
export function webhookTimestampMs(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n < 1e12 ? n * 1000 : n;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function webhookIsFresh(timestamp: string, nowMs: number = Date.now()): boolean {
  const at = webhookTimestampMs(timestamp);
  return at !== null && Math.abs(nowMs - at) <= WEBHOOK_MAX_AGE_MS;
}

interface TransferBody {
  transfer_id?: string;
  cf_transfer_id?: string | number;
  status?: string;
  transfer_utr?: string | null;
  status_description?: string | null;
  message?: string;
  code?: string;
  type?: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method: "GET" | "POST", path: string, requestId: string, body?: unknown): Promise<{ status: number; body: TransferBody; retryAfterMs: number }> {
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: cashfreePayoutHeaders(requestId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  }).catch((error: unknown) => {
    throw new PayoutProviderError(`Cashfree Payouts unreachable: ${error instanceof Error ? error.message : "network error"}`, true);
  });
  const parsed = (await response.json().catch(() => ({}))) as TransferBody | TransferBody[];
  const header = response.headers.get("retry-after");
  const retryAfter = header === null ? Number.NaN : Number(header);
  return {
    status: response.status,
    body: Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed,
    // Retry-After in seconds, at most 2 s here (a longer wait is left to the reconcile job); 1 s when absent.
    retryAfterMs: Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter * 1000, 2_000) : 1_000,
  };
}

function toStatus(body: TransferBody): TransferStatus & { status: Exclude<TransferStatus["status"], "NOT_FOUND"> } {
  const status = cashfreeTransferStatus(body.status);
  return {
    status,
    providerRef: body.cf_transfer_id != null ? String(body.cf_transfer_id) : null,
    utr: body.transfer_utr ? String(body.transfer_utr) : null,
    failureReason: status === "FAILED" || status === "REVERSED" ? (body.status_description ?? body.status ?? null) : null,
  };
}

export const cashfreePayoutProvider: PayoutProvider = {
  name: "CASHFREE",
  isConfigured() {
    const env = getEnv();
    // docs/payments-cashfree-audit-2026-11: sandbox payouts on gokesari.com would mark shops and
    // riders paid with no money sent (and production on the test site would send real money).
    return Boolean(env.CASHFREE_PAYOUT_CLIENT_ID && env.CASHFREE_PAYOUT_CLIENT_SECRET) && !cashfreeEnvProblem("payouts", env);
  },
  transferIdFor: cashfreeTransferId,
  async createTransfer(request: TransferRequest): Promise<TransferResult> {
    if (!this.isConfigured()) throw new PayoutProviderError("Cashfree Payouts keys are not configured.", false);
    const payload = cashfreeTransferBody(request);
    const transferId = payload.transfer_id as string;
    let answer = await call("POST", "/payout/transfers", request.idempotencyKey, payload);
    // 429: nothing was accepted — the same transfer_id is sent again, so it can never be paid twice.
    for (let tries = 1; answer.status === 429 && tries < RATE_LIMIT_TRIES; tries += 1) {
      await wait(answer.retryAfterMs);
      answer = await call("POST", "/payout/transfers", request.idempotencyKey, payload);
    }
    if (answer.status === 429) throw new PayoutProviderError("Cashfree Payouts is rate limiting requests (HTTP 429); the same transfer id is checked again later.", true);
    const duplicate = answer.status === 409 || /already[_ ]exists/i.test(`${answer.body.code ?? ""} ${answer.body.message ?? ""}`);
    if (duplicate) {
      // The transfer id was already used: this is a resend of an attempt Cashfree has — read its state.
      const known = await this.getTransfer!(transferId);
      if (known.status === "NOT_FOUND" || !known.providerRef) throw new PayoutProviderError("Cashfree reports the transfer id as used but cannot find it; check the Payouts dashboard.", true);
      return { status: known.status === "REVERSED" ? "PROCESSING" : known.status, providerRef: known.providerRef, utr: known.utr, failureReason: known.failureReason };
    }
    if (answer.status >= 500) throw new PayoutProviderError(answer.body.message ?? `Cashfree Payouts error (HTTP ${answer.status}).`, true);
    if (answer.status < 200 || answer.status >= 300 || answer.body.cf_transfer_id == null) {
      if (answer.status >= 200 && answer.status < 300) throw new PayoutProviderError("Cashfree accepted the request without a transfer reference.", true);
      throw new PayoutProviderError(answer.body.message ?? `Cashfree refused the transfer (HTTP ${answer.status}).`, false);
    }
    const known = toStatus(answer.body);
    return {
      status: known.status === "REVERSED" ? "PROCESSING" : known.status,
      providerRef: known.providerRef!,
      utr: known.utr,
      failureReason: known.status === "FAILED" ? known.failureReason : null,
    };
  },
  async getTransfer(transferId: string): Promise<TransferStatus> {
    if (!this.isConfigured()) throw new PayoutProviderError("Cashfree Payouts keys are not configured.", false);
    const answer = await call("GET", `/payout/transfers?transfer_id=${encodeURIComponent(transferId)}`, `status:${transferId}`);
    if (answer.status === 404 || /not[_ ]found/i.test(answer.body.code ?? "")) return { status: "NOT_FOUND", providerRef: null, utr: null, failureReason: null };
    if (answer.status < 200 || answer.status >= 300) {
      throw new PayoutProviderError(answer.body.message ?? `Cashfree status lookup failed (HTTP ${answer.status}).`, answer.status >= 500 || answer.status === 429);
    }
    return toStatus(answer.body);
  },
  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = getEnv().CASHFREE_PAYOUT_CLIENT_SECRET;
    const timestamp = headers.get("x-webhook-timestamp");
    if (!secret || !timestamp) return false;
    const given = Buffer.from(headers.get("x-webhook-signature") ?? "");
    const expected = Buffer.from(cashfreePayoutSignature(timestamp, rawBody, secret));
    if (!(given.length === expected.length && timingSafeEqual(given, expected))) return false;
    // A correctly signed but old event is refused too (replay).
    return webhookIsFresh(timestamp);
  },
  parseWebhook(rawBody: string): PayoutWebhookEvent {
    const body = JSON.parse(rawBody) as { type?: string; data?: TransferBody & Record<string, unknown> };
    const type = (body.type ?? "EVENT").toUpperCase();
    const data = body.data ?? {};
    const isTransfer = type.startsWith("TRANSFER_");
    const ref = data.cf_transfer_id != null ? String(data.cf_transfer_id) : null;
    const status = WEBHOOK_TYPE_STATUS[type] ?? cashfreeTransferStatus(data.status);
    const bodyHash = createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
    return {
      // A transfer event is one per transfer and type; any other event gets an id of its own.
      eventId: isTransfer && (ref || data.transfer_id) ? `${ref ?? data.transfer_id}:${type}` : `${type}:${bodyHash}`,
      kind: isTransfer ? "TRANSFER" : type === "LOW_BALANCE_ALERT" ? "LOW_BALANCE" : "OTHER",
      providerRef: isTransfer ? ref : null,
      // Our transfer_id: the attempt's provider_transfer_id. The service maps it back.
      referenceId: isTransfer ? (data.transfer_id ?? null) : null,
      transferId: isTransfer ? (data.transfer_id ?? null) : null,
      status: isTransfer ? status : "PROCESSING",
      utr: data.transfer_utr ? String(data.transfer_utr) : null,
      failureReason: data.status_description ?? (status === "FAILED" || status === "REVERSED" ? (data.status ?? null) : null),
      raw: body as unknown as Record<string, unknown>,
    };
  },
};
