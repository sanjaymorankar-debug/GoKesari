/**
 * The cart's pay button names the payment method the customer chose
 * (QA 24 Oct 2026: with "Pay online" chosen it still said "Pay from wallet").
 */
export type CheckoutPaymentChoice = "WALLET" | "COD" | "ONLINE";

export const PAY_BUTTON_LABELS: Record<CheckoutPaymentChoice, string> = {
  WALLET: "Pay from wallet",
  COD: "Place order — pay cash on delivery",
  ONLINE: "Pay online",
};

export function payButtonLabel(choice: CheckoutPaymentChoice, busy = false): string {
  return busy ? "Placing order…" : PAY_BUTTON_LABELS[choice];
}
