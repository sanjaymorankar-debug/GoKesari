/**
 * PayoutProvider — the contract every bank-transfer provider implements
 * (batch-2026-10 WS-E, F10.2.4). Adapters:
 *
 *   SANDBOX    deterministic simulator with signed webhooks and UTRs (never on gokesari.com)
 *   RAZORPAYX  RazorpayX Payouts (composite payout API) — scaffold, needs keys
 *   CASHFREE   Cashfree Payouts V2 — scaffold, needs keys
 *
 * BANK_FILE (rule payouts.provider) is not an adapter: finance downloads the
 * bulk-upload file and marks each payment paid with its UTR.
 */
export type PayoutProviderName = "SANDBOX" | "RAZORPAYX" | "CASHFREE";

export interface PayoutBeneficiary {
  name: string;
  method: "BANK_ACCOUNT" | "UPI";
  accountNumber?: string | null;
  ifsc?: string | null;
  upiId?: string | null;
}

export interface TransferRequest {
  /** Unique per attempt: a retried request with the same key never pays twice. */
  idempotencyKey: string;
  /** Our payout item id — echoed back by the provider in webhooks. */
  referenceId: string;
  amountPaise: number;
  mode: "NEFT" | "IMPS" | "RTGS" | "UPI";
  beneficiary: PayoutBeneficiary;
  narration: string;
  /** 1 for the first try. */
  attempt: number;
}

export interface TransferResult {
  status: "PROCESSING" | "SUCCESS" | "FAILED";
  providerRef: string;
  utr?: string | null;
  failureReason?: string | null;
}

export interface PayoutWebhookEvent {
  /** The provider's event id — a redelivered event has the same id. */
  eventId: string;
  providerRef: string | null;
  /** Our payout item id when the provider echoes it. */
  referenceId: string | null;
  status: "SUCCESS" | "FAILED" | "REVERSED" | "PROCESSING";
  utr: string | null;
  failureReason: string | null;
  raw: Record<string, unknown>;
}

export interface PayoutProvider {
  readonly name: PayoutProviderName;
  /** False without keys (or, for the sandbox, on the production site). */
  isConfigured(): boolean;
  createTransfer(request: TransferRequest): Promise<TransferResult>;
  /** Checks the signature over the exact raw body. */
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseWebhook(rawBody: string, headers: Headers): PayoutWebhookEvent;
}

export class PayoutProviderError extends Error {
  constructor(
    message: string,
    /** True when retrying later may succeed (network, 5xx). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PayoutProviderError";
  }
}
