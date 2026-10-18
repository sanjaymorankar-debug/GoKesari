/**
 * Cashfree Payouts (V2) adapter (batch-2026-10 WS-E) — SCAFFOLD.
 *
 * Configured by CASHFREE_PAYOUT_CLIENT_ID and CASHFREE_PAYOUT_CLIENT_SECRET
 * (Cashfree Payouts keys — not the payment-gateway CASHFREE_APP_ID /
 * CASHFREE_SECRET_KEY) and CASHFREE_PAYOUT_ENV (sandbox | production).
 * isConfigured() is false without both keys.
 *
 * From Cashfree's public documentation, NOT exercised against the API from
 * this environment (no network, no keys):
 *   - UNVERIFIED: POST {base}/payout/transfers, headers x-client-id,
 *     x-client-secret, x-api-version 2024-01-01; body transfer_id,
 *     transfer_amount (rupees), transfer_mode, beneficiary_details
 *     {beneficiary_name, beneficiary_instrument_details {bank_account_number,
 *     bank_ifsc | vpa}}.
 *   - UNVERIFIED: webhook types TRANSFER_SUCCESS / TRANSFER_FAILED /
 *     TRANSFER_REVERSED with data {transfer_id, cf_transfer_id, status,
 *     transfer_utr, status_description}; no event id is sent, so
 *     cf_transfer_id + type is used as the event id.
 *   - Signature: `x-webhook-signature` = base64 HMAC-SHA256 of
 *     (x-webhook-timestamp + raw body) with the client secret — the same
 *     scheme as Cashfree PG webhooks (implemented and unit-tested here).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { PayoutProviderError, type PayoutProvider, type PayoutWebhookEvent, type TransferRequest, type TransferResult } from "../types";

function base(): string {
  return getEnv().CASHFREE_PAYOUT_ENV === "production" ? "https://api.cashfree.com" : "https://sandbox.cashfree.com";
}

export function cashfreePayoutSignature(timestamp: string, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp + rawBody).digest("base64");
}

export const cashfreePayoutProvider: PayoutProvider = {
  name: "CASHFREE",
  isConfigured() {
    const env = getEnv();
    return Boolean(env.CASHFREE_PAYOUT_CLIENT_ID && env.CASHFREE_PAYOUT_CLIENT_SECRET);
  },
  async createTransfer(request: TransferRequest): Promise<TransferResult> {
    const env = getEnv();
    if (!this.isConfigured()) throw new PayoutProviderError("Cashfree Payouts keys are not configured.", false);
    const instrument =
      request.beneficiary.method === "UPI"
        ? { vpa: request.beneficiary.upiId }
        : { bank_account_number: request.beneficiary.accountNumber, bank_ifsc: request.beneficiary.ifsc };
    const response = await fetch(`${base()}/payout/transfers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": env.CASHFREE_PAYOUT_CLIENT_ID!,
        "x-client-secret": env.CASHFREE_PAYOUT_CLIENT_SECRET!,
        "x-api-version": "2024-01-01",
        "x-request-id": request.idempotencyKey,
      },
      body: JSON.stringify({
        // Cashfree's transfer_id is its idempotency key: alphanumeric and _ only.
        transfer_id: request.idempotencyKey.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40),
        transfer_amount: request.amountPaise / 100,
        transfer_currency: "INR",
        transfer_mode: request.mode === "UPI" ? "upi" : request.mode.toLowerCase(),
        transfer_remarks: request.narration.slice(0, 70),
        beneficiary_details: { beneficiary_name: request.beneficiary.name, beneficiary_instrument_details: instrument },
      }),
    }).catch((error: unknown) => {
      throw new PayoutProviderError(`Cashfree Payouts unreachable: ${error instanceof Error ? error.message : "network error"}`, true);
    });
    const body = (await response.json().catch(() => ({}))) as { cf_transfer_id?: string; status?: string; transfer_utr?: string | null; status_description?: string; message?: string };
    if (!response.ok || !body.cf_transfer_id) {
      throw new PayoutProviderError(body.message ?? `Cashfree refused the transfer (HTTP ${response.status}).`, response.status >= 500);
    }
    const status = body.status === "SUCCESS" ? "SUCCESS" : body.status === "FAILED" || body.status === "REJECTED" ? "FAILED" : "PROCESSING";
    return { status, providerRef: String(body.cf_transfer_id), utr: body.transfer_utr ?? null, failureReason: status === "FAILED" ? (body.status_description ?? null) : null };
  },
  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = getEnv().CASHFREE_PAYOUT_CLIENT_SECRET;
    const timestamp = headers.get("x-webhook-timestamp");
    if (!secret || !timestamp) return false;
    const given = Buffer.from(headers.get("x-webhook-signature") ?? "");
    const expected = Buffer.from(cashfreePayoutSignature(timestamp, rawBody, secret));
    return given.length === expected.length && timingSafeEqual(given, expected);
  },
  parseWebhook(rawBody: string): PayoutWebhookEvent {
    const body = JSON.parse(rawBody) as {
      type?: string;
      data?: { transfer_id?: string; cf_transfer_id?: string | number; status?: string; transfer_utr?: string | null; status_description?: string | null };
    };
    const data = body.data ?? {};
    const status = body.type === "TRANSFER_SUCCESS" ? "SUCCESS" : body.type === "TRANSFER_REVERSED" ? "REVERSED" : body.type === "TRANSFER_FAILED" || body.type === "TRANSFER_REJECTED" ? "FAILED" : "PROCESSING";
    const ref = data.cf_transfer_id != null ? String(data.cf_transfer_id) : null;
    return {
      eventId: `${ref ?? data.transfer_id ?? "unknown"}:${body.type ?? "event"}`,
      providerRef: ref,
      // Our transfer_id is the item's idempotency key for that attempt; the service maps it back.
      referenceId: data.transfer_id ?? null,
      status,
      utr: data.transfer_utr ?? null,
      failureReason: data.status_description ?? null,
      raw: body as unknown as Record<string, unknown>,
    };
  },
};
