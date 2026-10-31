/** Rider transfer statuses in plain words (docs/gig-bank-payouts-2026-10). */
export const TRANSFER_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  PENDING: { label: "Pending", tone: "info" },
  PROCESSING: { label: "On its way", tone: "info" },
  SUCCESS: { label: "Paid", tone: "success" },
  FAILED: { label: "Failed — retrying", tone: "warning" },
  REVERSED: { label: "Returned by bank", tone: "danger" },
  RELEASED: { label: "Failed — back in balance", tone: "danger" },
};

export const KIND_LABEL = { WITHDRAWAL: "Withdrawal", MONTHLY: "Monthly payout" } as const;
