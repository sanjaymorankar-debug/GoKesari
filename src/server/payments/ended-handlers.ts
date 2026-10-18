/**
 * What happens when a payment attempt for each purpose ends without money
 * (FAILED or EXPIRED) — the counterpart of CAPTURED_HANDLERS in
 * purpose-handlers.ts (batch-2026-10 WS-A). Runs inside the transaction that
 * moves the intent, so the purpose's change and the intent's commit together.
 * A purpose without an entry needs nothing beyond the payment.failed /
 * payment.expired event (which tells the customer).
 */
import type { DbClient } from "@/server/db";
import type { PaymentIntentRow } from "@/server/db/schema";
import type { PaymentPurpose } from "./intents";
import { onOrderPaymentEnded } from "./order-payments";

export type EndedHandler = (intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient) => Promise<void>;

export const PAYMENT_ENDED_HANDLERS: Partial<Record<PaymentPurpose, EndedHandler>> = {
  ORDER: (intent, to, client) => onOrderPaymentEnded(intent, to, client),
  ORDER_GROUP: (intent, to, client) => onOrderPaymentEnded(intent, to, client),
};
