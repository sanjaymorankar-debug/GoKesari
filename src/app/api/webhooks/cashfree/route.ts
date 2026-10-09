/**
 * Cashfree server-to-server webhook (requirements §3, §4, §41).
 *
 * This is the safety net the client-invoked `/api/wallet/verify` cannot be:
 * that endpoint only fires if the customer's browser stays online long enough
 * to call it back. If it closes the tab, loses connectivity, or the checkout
 * modal simply errors, Cashfree still has the money and this webhook is the
 * only remaining path that credits the wallet.
 *
 * Security, in order:
 *  1. Read the RAW body — signature verification is over the exact bytes
 *     Cashfree sent, not a re-serialised JSON.parse/stringify round-trip.
 *  2. Verify `x-webhook-signature` (HMAC-SHA256 over `timestamp + rawBody`,
 *     keyed on CASHFREE_SECRET_KEY) BEFORE touching anything else in the
 *     payload.
 *  3. Only then parse and act on it.
 *
 * Idempotent and retry-safe by construction, not by any special-casing here:
 * `creditFromWebhook` → `finalizeVerifiedPayment` does a conditional
 * `UPDATE ... WHERE status = 'CREATED'`, so a redelivered event (Cashfree
 * retries on anything but 2xx) finds the payment already SUCCESS and returns
 * without moving money twice — the same guarantee that protects the
 * client-invoked path racing against this one.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getEnv } from "@/lib/env";
import { isRegistrationOrder, processRegistrationPaymentEvent } from "@/server/registration/service";
import { creditFromWebhook, verifyWebhookSignature } from "@/server/services/payments";

export const dynamic = "force-dynamic";

interface CashfreeWebhookPayload {
  type: string;
  data?: {
    order?: { order_id?: string; order_amount?: number; order_currency?: string };
    payment?: { cf_payment_id?: string | number; payment_status?: string; payment_amount?: number; payment_currency?: string };
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!getEnv().CASHFREE_SECRET_KEY) {
    // No credentials configured — nothing to verify against. Refuse rather
    // than silently accepting unauthenticated payloads (§3 "never put secret
    // keys in frontend code" extends to: never accept a webhook we cannot
    // authenticate).
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const signature = request.headers.get("x-webhook-signature");
  const timestamp = request.headers.get("x-webhook-timestamp");
  if (!signature || !timestamp) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const rawBody = await request.text();
  if (!verifyWebhookSignature(rawBody, timestamp, signature)) {
    console.error("[webhook] Cashfree signature verification failed");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: CashfreeWebhookPayload;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  // Module 3: shop self-registration fees (reg_ orders) — approved here and
  // only here, after the amount is checked against the fee. Failed / dropped
  // payments are recorded so the applicant can retry.
  const registrationOrderId = event.data?.order?.order_id;
  if (registrationOrderId && isRegistrationOrder(registrationOrderId)) {
    try {
      const outcome = await processRegistrationPaymentEvent({
        orderId: registrationOrderId,
        paymentId: event.data?.payment?.cf_payment_id != null ? String(event.data.payment.cf_payment_id) : null,
        paymentStatus: event.data?.payment?.payment_status ?? (event.type === "PAYMENT_SUCCESS_WEBHOOK" ? "SUCCESS" : event.type),
        orderAmount: event.data?.order?.order_amount ?? null,
        paymentAmount: event.data?.payment?.payment_amount ?? null,
        currency: event.data?.payment?.payment_currency ?? event.data?.order?.order_currency ?? null,
        raw: event as unknown as Record<string, unknown>,
      });
      return NextResponse.json({ received: true, outcome: outcome.outcome });
    } catch (error) {
      console.error("[webhook] registration payment processing failed", error);
      return NextResponse.json({ error: "Processing failed" }, { status: 500 });
    }
  }

  // Only a SUCCESS payment actually confirms money moved. Other event types
  // (order-level updates, failed/dropped payments) are acknowledged (2xx, so
  // Cashfree stops retrying) but intentionally not acted on — acting on
  // anything short of a confirmed success risks crediting a wallet for a
  // payment that never completed.
  if (event.type !== "PAYMENT_SUCCESS_WEBHOOK" || event.data?.payment?.payment_status !== "SUCCESS") {
    return NextResponse.json({ received: true });
  }

  const gatewayOrderId = event.data?.order?.order_id;
  const gatewayPaymentId = event.data?.payment?.cf_payment_id;
  if (!gatewayOrderId || !gatewayPaymentId) {
    return NextResponse.json({ error: "Missing payment identifiers" }, { status: 400 });
  }

  try {
    await creditFromWebhook(gatewayOrderId, String(gatewayPaymentId));
  } catch (error) {
    // A genuine processing failure (DB unavailable, etc.) — return non-2xx so
    // Cashfree retries per its documented backoff, rather than silently
    // losing the confirmation.
    console.error("[webhook] failed to process PAYMENT_SUCCESS_WEBHOOK", error);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
