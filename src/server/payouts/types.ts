/**
 * PayoutProvider — the contract every bank-transfer provider implements
 * (batch-2026-10 WS-E, F10.2.4). Adapters:
 *
 *   SANDBOX    deterministic simulator with signed webhooks and UTRs (never on gokesari.com)
 *   RAZORPAYX  RazorpayX Payouts (composite payout API) — scaffold, needs keys
 *   CASHFREE   Cashfree Payouts V2 — needs keys, and env CASHFREE_PAYOUTS_CONTRACT_VERIFIED=true
 *              before any rule may send through it (src/server/payouts/guard.ts)
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

/** A transfer's state at the provider (status lookup, used by the reconcile job). */
export interface TransferStatus {
  /** NOT_FOUND: the provider has no transfer with that id (the request never reached it). */
  status: "SUCCESS" | "FAILED" | "REVERSED" | "PROCESSING" | "NOT_FOUND";
  providerRef: string | null;
  utr: string | null;
  failureReason: string | null;
}

export interface PayoutWebhookEvent {
  /** The provider's event id — a redelivered event has the same id. */
  eventId: string;
  /**
   * TRANSFER for a transfer's status; anything else (e.g. LOW_BALANCE_ALERT) is
   * an account notice that matches no payout.
   */
  kind?: "TRANSFER" | "LOW_BALANCE" | "OTHER";
  providerRef: string | null;
  /** Our payout item id when the provider echoes it. */
  referenceId: string | null;
  /** The transfer id we sent (provider_transfer_id), when the provider echoes it. */
  transferId?: string | null;
  status: "SUCCESS" | "FAILED" | "REVERSED" | "PROCESSING";
  utr: string | null;
  failureReason: string | null;
  raw: Record<string, unknown>;
}

export interface PayoutProvider {
  readonly name: PayoutProviderName;
  /** False without keys (or, for the sandbox, on the production site). */
  isConfigured(): boolean;
  /**
   * The id the provider knows this attempt by (its idempotency key), worked out
   * from the request's idempotencyKey. Saved on the row before the request is
   * sent, so a webhook that arrives early (or after a timeout) still matches.
   */
  transferIdFor(idempotencyKey: string): string;
  createTransfer(request: TransferRequest): Promise<TransferResult>;
  /** Status lookup by our transfer id (transferIdFor). Absent when the provider has none. */
  getTransfer?(transferId: string): Promise<TransferStatus>;
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
