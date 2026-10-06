/**
 * SM-004: how a subscription's status reads to a customer, shop or admin —
 * one place for the label and badge tone of every subscription status.
 */
export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  PAUSED: "Paused",
  RENEWAL_PENDING: "Renewal pending",
  PAYMENT_PENDING: "Payment pending",
  CANCELLED: "Cancelled",
  COMPLETED: "Ended",
};

export function subscriptionStatusTone(status: string): "success" | "danger" | "warning" | "info" | "neutral" {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "PAYMENT_PENDING":
      return "danger";
    case "RENEWAL_PENDING":
    case "PAUSED":
      return "warning";
    case "DRAFT":
      return "info";
    default:
      return "neutral";
  }
}

export function subscriptionStatusLabel(status: string, renewalReason?: string | null): string {
  const base = SUBSCRIPTION_STATUS_LABELS[status] ?? status.replace(/_/g, " ").toLowerCase();
  if (status !== "RENEWAL_PENDING" || !renewalReason) return base;
  return renewalReason === "PAYMENT_DUE" ? "Renewal pending — top up" : "Renewal pending — term ends";
}
