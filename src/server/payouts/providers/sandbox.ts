/**
 * Sandbox payout provider (batch-2026-10 WS-E) — deterministic, no network.
 *
 * Outcome by the paise part of the amount, so tests and demos can choose it:
 *   …98 paise  always fails ("Beneficiary bank is offline (sandbox)")
 *   …99 paise  fails on the first attempt, succeeds on a retry
 *   otherwise  succeeds
 * A transfer is accepted as PROCESSING; its result arrives as a webhook
 * (buildSandboxWebhook), signed HMAC-SHA256 (hex) over the raw body with
 * PAYOUT_SANDBOX_WEBHOOK_SECRET (default: derived from AUTH_SECRET) in
 * `x-sandbox-signature`, event id in `x-sandbox-event-id`. A success carries
 * a 16-character UTR ("SBXN" + 12 digits) derived from the transfer.
 * Never available on the production site (gokesari.com).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { isProductionSite } from "@/server/services/bank-accounts";
import type { PayoutProvider, PayoutWebhookEvent, TransferRequest, TransferResult } from "../types";

export function sandboxWebhookSecret(): string {
  const env = getEnv();
  return env.PAYOUT_SANDBOX_WEBHOOK_SECRET ?? createHash("sha256").update(`gokesari-payout-sandbox:${env.AUTH_SECRET}`).digest("hex");
}

export function sandboxOutcome(amountPaise: number, attempt: number): { ok: boolean; reason: string | null } {
  const paise = amountPaise % 100;
  if (paise === 98) return { ok: false, reason: "Beneficiary bank is offline (sandbox)." };
  if (paise === 99 && attempt <= 1) return { ok: false, reason: "Temporary NEFT failure (sandbox) — retry." };
  return { ok: true, reason: null };
}

export function sandboxRef(idempotencyKey: string): string {
  return `sbx_${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 20)}`;
}

export function sandboxUtr(providerRef: string): string {
  const digits = BigInt(`0x${createHash("sha256").update(`utr:${providerRef}`).digest("hex").slice(0, 15)}`).toString().padStart(12, "0").slice(-12);
  return `SBXN${digits}`;
}

/** What the sandbox "bank" remembers about each transfer (in-process, for building webhooks). */
const transfers = new Map<string, { request: TransferRequest; ok: boolean; reason: string | null }>();

export const sandboxPayoutProvider: PayoutProvider = {
  name: "SANDBOX",
  isConfigured: () => !isProductionSite(),
  async createTransfer(request: TransferRequest): Promise<TransferResult> {
    if (isProductionSite()) throw new Error("The payout sandbox never runs on the production site.");
    const providerRef = sandboxRef(request.idempotencyKey);
    const outcome = sandboxOutcome(request.amountPaise, request.attempt);
    transfers.set(providerRef, { request, ...outcome });
    return { status: "PROCESSING", providerRef };
  },
  verifyWebhook(rawBody: string, headers: Headers): boolean {
    const given = headers.get("x-sandbox-signature") ?? "";
    const expected = createHmac("sha256", sandboxWebhookSecret()).update(rawBody).digest("hex");
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  },
  parseWebhook(rawBody: string, headers: Headers): PayoutWebhookEvent {
    const body = JSON.parse(rawBody) as {
      event: string;
      transfer: { id: string; reference_id: string; status: string; utr?: string | null; failure_reason?: string | null };
    };
    const status = body.transfer.status === "processed" ? "SUCCESS" : body.transfer.status === "reversed" ? "REVERSED" : body.transfer.status === "failed" ? "FAILED" : "PROCESSING";
    return {
      eventId: headers.get("x-sandbox-event-id") ?? `${body.transfer.id}:${body.event}`,
      providerRef: body.transfer.id,
      referenceId: body.transfer.reference_id,
      status,
      utr: body.transfer.utr ?? null,
      failureReason: body.transfer.failure_reason ?? null,
      raw: body as unknown as Record<string, unknown>,
    };
  },
};

/**
 * The webhook the sandbox "bank" sends for a transfer: processed (with UTR)
 * or failed, or `reversed` when asked. Signed like a real one.
 */
export function buildSandboxWebhook(
  providerRef: string,
  fallback: { referenceId: string; amountPaise: number; attempt: number },
  override?: "processed" | "failed" | "reversed",
): { rawBody: string; headers: Headers } {
  const known = transfers.get(providerRef);
  const outcome = known ?? { ...sandboxOutcome(fallback.amountPaise, fallback.attempt), request: null };
  const status = override ?? (outcome.ok ? "processed" : "failed");
  const body = {
    event: `payout.${status}`,
    transfer: {
      id: providerRef,
      reference_id: known?.request.referenceId ?? fallback.referenceId,
      amount: known?.request.amountPaise ?? fallback.amountPaise,
      status,
      utr: status === "processed" || status === "reversed" ? sandboxUtr(providerRef) : null,
      failure_reason: status === "failed" ? (outcome.reason ?? "Failed (sandbox).") : status === "reversed" ? "Returned by the beneficiary bank (sandbox)." : null,
    },
  };
  const rawBody = JSON.stringify(body);
  const headers = new Headers({
    "content-type": "application/json",
    "x-sandbox-event-id": `evt_${createHash("sha256").update(`${providerRef}:${status}`).digest("hex").slice(0, 24)}`,
    "x-sandbox-signature": createHmac("sha256", sandboxWebhookSecret()).update(rawBody).digest("hex"),
  });
  return { rawBody, headers };
}
