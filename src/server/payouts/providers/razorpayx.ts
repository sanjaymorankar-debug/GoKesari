/**
 * RazorpayX Payouts adapter (batch-2026-10 WS-E) — SCAFFOLD.
 *
 * Configured by RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET (Basic auth),
 * RAZORPAYX_ACCOUNT_NUMBER (the RazorpayX current account money is paid
 * from) and RAZORPAYX_WEBHOOK_SECRET. isConfigured() is false without all four.
 *
 * Verified against Razorpay's public documentation only — NOT exercised
 * against the live API from this environment (no network, no keys):
 *   - UNVERIFIED: POST https://api.razorpay.com/v1/payouts with a composite
 *     `fund_account` (contact + bank_account / vpa) and the
 *     `X-Payout-Idempotency` header; field names per the docs at build time.
 *   - UNVERIFIED: webhook events payout.processed / payout.reversed /
 *     payout.failed with payload.payout.entity {id, reference_id, status, utr,
 *     failure_reason}; event id in the `X-Razorpay-Event-Id` header.
 *   - Signature: `X-Razorpay-Signature` = hex HMAC-SHA256 of the raw body with
 *     the webhook secret (documented scheme; implemented and unit-tested here).
 * Run one sandbox (test-mode) payout end to end before switching
 * rule payouts.provider to RAZORPAYX.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { PayoutProviderError, type PayoutProvider, type PayoutWebhookEvent, type TransferRequest, type TransferResult } from "../types";

const API = "https://api.razorpay.com/v1";

export function razorpayxSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export const razorpayxPayoutProvider: PayoutProvider = {
  name: "RAZORPAYX",
  isConfigured() {
    const env = getEnv();
    return Boolean(env.RAZORPAYX_KEY_ID && env.RAZORPAYX_KEY_SECRET && env.RAZORPAYX_ACCOUNT_NUMBER && env.RAZORPAYX_WEBHOOK_SECRET);
  },
  async createTransfer(request: TransferRequest): Promise<TransferResult> {
    const env = getEnv();
    if (!this.isConfigured()) throw new PayoutProviderError("RazorpayX keys are not configured.", false);
    const fundAccount =
      request.beneficiary.method === "UPI"
        ? { account_type: "vpa", vpa: { address: request.beneficiary.upiId } }
        : {
            account_type: "bank_account",
            bank_account: { name: request.beneficiary.name, ifsc: request.beneficiary.ifsc, account_number: request.beneficiary.accountNumber },
          };
    const response = await fetch(`${API}/payouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${Buffer.from(`${env.RAZORPAYX_KEY_ID}:${env.RAZORPAYX_KEY_SECRET}`).toString("base64")}`,
        "X-Payout-Idempotency": request.idempotencyKey,
      },
      body: JSON.stringify({
        account_number: env.RAZORPAYX_ACCOUNT_NUMBER,
        amount: request.amountPaise,
        currency: "INR",
        mode: request.mode,
        purpose: "payout",
        queue_if_low_balance: true,
        reference_id: request.referenceId,
        narration: request.narration.slice(0, 30),
        fund_account: { ...fundAccount, contact: { name: request.beneficiary.name, type: "vendor", reference_id: request.referenceId } },
      }),
    }).catch((error: unknown) => {
      throw new PayoutProviderError(`RazorpayX unreachable: ${error instanceof Error ? error.message : "network error"}`, true);
    });
    const body = (await response.json().catch(() => ({}))) as { id?: string; status?: string; utr?: string | null; failure_reason?: string | null; error?: { description?: string } };
    if (!response.ok || !body.id) {
      throw new PayoutProviderError(body.error?.description ?? `RazorpayX refused the payout (HTTP ${response.status}).`, response.status >= 500);
    }
    const status = body.status === "processed" ? "SUCCESS" : body.status === "failed" || body.status === "rejected" || body.status === "cancelled" ? "FAILED" : "PROCESSING";
    return { status, providerRef: body.id, utr: body.utr ?? null, failureReason: body.failure_reason ?? null };
  },
  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const secret = getEnv().RAZORPAYX_WEBHOOK_SECRET;
    if (!secret) return false;
    const given = Buffer.from(headers.get("x-razorpay-signature") ?? "");
    const expected = Buffer.from(razorpayxSignature(rawBody, secret));
    return given.length === expected.length && timingSafeEqual(given, expected);
  },
  parseWebhook(rawBody: string, headers: Headers): PayoutWebhookEvent {
    const body = JSON.parse(rawBody) as {
      event?: string;
      payload?: { payout?: { entity?: { id?: string; reference_id?: string; status?: string; utr?: string | null; failure_reason?: string | null } } };
    };
    const entity = body.payload?.payout?.entity ?? {};
    const status =
      body.event === "payout.processed" ? "SUCCESS" : body.event === "payout.reversed" ? "REVERSED" : body.event === "payout.failed" || body.event === "payout.rejected" ? "FAILED" : "PROCESSING";
    return {
      eventId: headers.get("x-razorpay-event-id") ?? `${entity.id ?? "unknown"}:${body.event ?? "event"}`,
      providerRef: entity.id ?? null,
      referenceId: entity.reference_id ?? null,
      status,
      utr: entity.utr ?? null,
      failureReason: entity.failure_reason ?? null,
      raw: body as unknown as Record<string, unknown>,
    };
  },
};
