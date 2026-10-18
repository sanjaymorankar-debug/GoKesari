/**
 * What happens when a payment for each purpose is captured (batch-2026-10).
 * Called by the payments service inside the transaction that marks the intent
 * CAPTURED, so the purpose's state change and the capture commit together.
 * Each workstream adds its handler in its own section.
 */
import type { DbClient } from "@/server/db";
import type { PaymentIntentRef, PaymentPurpose } from "./intents";

export type CapturedHandler = (intent: PaymentIntentRef, client: DbClient) => Promise<void>;

export const CAPTURED_HANDLERS: Partial<Record<PaymentPurpose, CapturedHandler>> = {
  /* >>> batch-2026-10 WS-A (payments, OTP, reference prices) — add entries below this line only */
  // Orders paid online: every order still waiting for this payment becomes CONFIRMED + paid
  // (order-payments.ts; imported lazily so this registry adds no import cycle).
  ORDER: async (intent, client) => (await import("./order-payments")).onOrderPaymentCaptured(intent, client),
  ORDER_GROUP: async (intent, client) => (await import("./order-payments")).onOrderPaymentCaptured(intent, client),
  /* <<< end WS-A */
  //
  /* >>> batch-2026-10 WS-D (operator-limited, product master data) — add entries below this line only */
  /* <<< end WS-D */
  //
};
