/**
 * How an order is paid (orders.payment_method), as the customer's order page
 * and the shop's order card name it (TC-SPI-006 / TC-SPI-008). Client-safe.
 */
export const PAYMENT_METHOD_LABELS: Record<"WALLET" | "COD" | "ONLINE", string> = {
  WALLET: "Wallet",
  COD: "Cash on delivery",
  ONLINE: "Online (UPI / card / net banking)",
};

export function paymentMethodLabel(method: string | null | undefined): string | null {
  return method && method in PAYMENT_METHOD_LABELS ? PAYMENT_METHOD_LABELS[method as keyof typeof PAYMENT_METHOD_LABELS] : null;
}
