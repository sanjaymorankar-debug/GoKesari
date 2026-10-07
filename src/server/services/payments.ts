/**
 * Payment gateway integration — Cashfree (requirements §18, §20, §48).
 *
 * The rule that matters: **the wallet is credited only after the gateway
 * itself confirms payment server-to-server.** A client claiming "payment
 * succeeded" proves nothing. Cashfree's checkout widget does not hand the
 * browser a payment id/signature pair to verify locally the way some gateways
 * do — instead, after checkout the server independently calls Cashfree's Get
 * Order API using its own credentials and trusts only what THAT call reports.
 * The webhook (HMAC-SHA256 over `timestamp + rawBody`, base64) is the
 * server-to-server safety net for when the customer's browser never reports
 * back at all.
 *
 * Replay protection is structural rather than procedural:
 *   - `payments.gateway_payment_id` is UNIQUE, so the same Cashfree payment can
 *     never be recorded twice.
 *   - The wallet credit uses `topup:<paymentId>` as its idempotency key, so even
 *     if the client-invoked check and the webhook both fire, only one credit is
 *     applied.
 *
 * With no Cashfree credentials configured the service runs in MOCK mode so the
 * whole flow — including verification — is exercisable in development and tests.
 */
import crypto from "node:crypto";

import { and, eq } from "drizzle-orm";

import { cashfreeApiBase, getEnv, isPaymentGatewayLive } from "@/lib/env";
import {
  conflict,
  notFound,
  paymentVerificationFailed,
  validationFailed,
} from "@/lib/errors";
import { db } from "@/server/db";
import { payments, users, type Payment } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getOrCreateWallet, applyWalletMutation } from "./wallet";
import { previewVoucher, redeemVoucher } from "./vouchers";

/** Minimum top-up, in paise. */
const MIN_TOPUP_PAISE = 100;
/** Sanity ceiling to blunt fat-finger and abuse cases. */
const MAX_TOPUP_PAISE = 10_000_000; // ₹1,00,000

export interface CreateTopUpResult {
  payment: Payment;
  gatewayOrderId: string;
  /** Passed to the Cashfree checkout widget. Null in mock mode. */
  paymentSessionId: string | null;
  /** Which Cashfree environment the widget should talk to. */
  cashfreeMode: "sandbox" | "production";
  amountPaise: number;
  currency: string;
  mock: boolean;
  /** Set only when a voucher code was supplied and validated (§18 preview). */
  voucherPreview: {
    code: string;
    name: string;
    bonusPercent: number;
    bonusAmountPaise: number;
    totalCreditPaise: number;
  } | null;
}

export async function createTopUpOrder(
  userId: string,
  amountPaise: number,
  voucherCode?: string | null,
): Promise<CreateTopUpResult> {
  if (!Number.isInteger(amountPaise)) {
    throw validationFailed("Amount must be a whole number of paise.");
  }
  if (amountPaise < MIN_TOPUP_PAISE) {
    throw validationFailed("The minimum top-up is ₹1.");
  }
  if (amountPaise > MAX_TOPUP_PAISE) {
    throw validationFailed("The maximum top-up is ₹1,00,000.");
  }

  // Validated and computed HERE, at order-creation time, then the code (not
  // the bonus figure) is stored on the payment row. Verification re-derives
  // the bonus from the voucher and the payment's own amount — the client
  // never gets to supply a bonus amount at any point (§32).
  const voucherPreview = voucherCode
    ? await previewVoucher(voucherCode, amountPaise, userId)
    : null;

  const live = isPaymentGatewayLive();

  let gatewayOrderId: string;
  let paymentSessionId: string | null = null;
  if (live) {
    const order = await createCashfreeOrder(amountPaise, userId);
    gatewayOrderId = order.gatewayOrderId;
    paymentSessionId = order.paymentSessionId;
  } else {
    gatewayOrderId = `mock_order_${crypto.randomUUID()}`;
  }

  const [payment] = await db
    .insert(payments)
    .values({
      userId,
      gateway: live ? "CASHFREE" : "MOCK",
      gatewayOrderId,
      amountPaise,
      currency: "INR",
      status: "CREATED",
      purpose: "WALLET_TOPUP",
      voucherCode: voucherPreview?.code ?? null,
    })
    .returning();

  return {
    payment,
    gatewayOrderId,
    paymentSessionId,
    cashfreeMode: getEnv().CASHFREE_ENV,
    amountPaise,
    currency: "INR",
    mock: !live,
    voucherPreview: voucherPreview
      ? {
          code: voucherPreview.code!,
          name: voucherPreview.name,
          bonusPercent: voucherPreview.bonusPercent,
          bonusAmountPaise: voucherPreview.bonusAmountPaise,
          totalCreditPaise: voucherPreview.totalCreditPaise,
        }
      : null,
  };
}

export interface VerifyTopUpResult {
  payment: Payment;
  balancePaise: number;
  /** True when this callback had already been processed. */
  alreadyProcessed: boolean;
  voucherBonusPaise: number;
}

/**
 * Shared prefix for both verification entry points below: look up the
 * payment, check ownership, and short-circuit if it's already settled or
 * dead. Returns `null` when the caller should stop and return the given
 * result as-is; otherwise returns the live `payment` row to keep verifying.
 */
async function loadVerifiablePayment(
  userId: string,
  gatewayOrderId: string,
): Promise<{ payment: Payment; alreadySettled: VerifyTopUpResult | null }> {
  const payment = await db.query.payments.findFirst({
    where: eq(payments.gatewayOrderId, gatewayOrderId),
  });
  if (!payment) throw notFound("Payment");

  // A payment may only ever be settled by the user who initiated it.
  if (payment.userId !== userId) {
    throw paymentVerificationFailed("This payment does not belong to you.");
  }

  // Replay: already verified — including by the webhook, which may have won
  // the race. Return the existing state rather than re-crediting.
  if (payment.status === "SUCCESS") {
    const wallet = await db.query.wallets.findFirst({
      where: (w, { eq: equals }) => equals(w.userId, userId),
    });
    return {
      payment,
      alreadySettled: {
        payment,
        balancePaise: wallet?.balancePaise ?? 0,
        alreadyProcessed: true,
        voucherBonusPaise: 0,
      },
    };
  }

  if (payment.status === "REFUNDED" || payment.status === "FAILED") {
    throw conflict("This payment can no longer be completed.");
  }

  return { payment, alreadySettled: null };
}

/**
 * Confirms a live Cashfree order and credits the wallet.
 *
 * Nothing the client sends is trusted here beyond which order to check —
 * the actual proof of payment comes from calling Cashfree's own Get Order
 * API server-to-server. Order of operations is deliberate: confirm payment
 * FIRST, then mark the payment, then credit. A forged callback never reaches
 * the wallet, because there is nothing to forge — the client cannot make
 * Cashfree report a payment that didn't happen.
 */
export async function verifyAndCreditTopUp(input: {
  userId: string;
  gatewayOrderId: string;
}): Promise<VerifyTopUpResult> {
  const { payment, alreadySettled } = await loadVerifiablePayment(
    input.userId,
    input.gatewayOrderId,
  );
  if (alreadySettled) return alreadySettled;

  const confirmed = await confirmCashfreeOrderPaid(input.gatewayOrderId);
  if (!confirmed) {
    await db
      .update(payments)
      .set({
        status: "FAILED",
        failureReason: "Cashfree did not confirm payment for this order",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    throw paymentVerificationFailed();
  }

  return finalizeVerifiedPayment(payment, {
    gatewayPaymentId: confirmed.cfPaymentId,
    gatewaySignature: null,
  });
}

/**
 * Dev-only counterpart to `verifyAndCreditTopUp` for MOCK-mode payments,
 * which have no real Cashfree order to ask. Still verifies a genuine HMAC
 * (via `signForMock`) rather than crediting unconditionally, so the mock
 * flow exercises real verification logic end to end — see `signForMock`.
 */
export async function settleMockTopUp(input: {
  userId: string;
  gatewayOrderId: string;
  gatewayPaymentId: string;
  signature: string;
}): Promise<VerifyTopUpResult> {
  const { payment, alreadySettled } = await loadVerifiablePayment(
    input.userId,
    input.gatewayOrderId,
  );
  if (alreadySettled) return alreadySettled;

  const signatureValid = verifyMockSignature(
    input.gatewayOrderId,
    input.gatewayPaymentId,
    input.signature,
  );
  if (!signatureValid) {
    await db
      .update(payments)
      .set({
        status: "FAILED",
        failureReason: "Mock signature verification failed",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    throw paymentVerificationFailed();
  }

  return finalizeVerifiedPayment(payment, {
    gatewayPaymentId: input.gatewayPaymentId,
    gatewaySignature: input.signature,
  });
}

/**
 * Marks a payment SUCCESS and credits the wallet — the one code path both
 * `verifyAndCreditTopUp` (client-invoked, confirmed via Cashfree's Get Order
 * API) and the Cashfree webhook (server-to-server, webhook-signature
 * verified) funnel into once THEIR OWN authentication has passed. Whichever
 * one reaches here
 * first wins; the other's replay is absorbed by the SUCCESS-status check in
 * its own caller, or by the UNIQUE index on `payments.gateway_payment_id` /
 * the wallet idempotency key if both race past that check simultaneously.
 */
async function finalizeVerifiedPayment(
  payment: Payment,
  gateway: { gatewayPaymentId: string; gatewaySignature: string | null },
): Promise<VerifyTopUpResult> {
  // Mark verified. The UNIQUE index on gateway_payment_id means a concurrent
  // duplicate callback fails here rather than producing a second credit.
  const [verified] = await db
    .update(payments)
    .set({
      gatewayPaymentId: gateway.gatewayPaymentId,
      gatewaySignature: gateway.gatewaySignature,
      status: "SUCCESS",
      verifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(payments.id, payment.id), eq(payments.status, "CREATED")))
    .returning();

  // Another caller (the other of {client verify, webhook}) won the race
  // between our SELECT above and this UPDATE — treat as an already-processed
  // replay rather than crediting twice.
  if (!verified) {
    const settled = await db.query.payments.findFirst({
      where: eq(payments.id, payment.id),
    });
    const wallet = await db.query.wallets.findFirst({
      where: (w, { eq: equals }) => equals(w.userId, payment.userId),
    });
    return {
      payment: settled ?? payment,
      balancePaise: wallet?.balancePaise ?? 0,
      alreadyProcessed: true,
      voucherBonusPaise: 0,
    };
  }

  // Credit the REAL money only now, keyed on the gateway payment id. This
  // step is guaranteed: nothing about the voucher below is allowed to stop
  // money the customer actually paid from reaching their wallet.
  const result = await applyWalletMutation({
    userId: payment.userId,
    amountPaise: payment.amountPaise,
    type: "TOP_UP",
    idempotencyKey: `topup:${gateway.gatewayPaymentId}`,
    description: "Wallet top-up",
    paymentId: payment.id,
  });

  await recordAudit({
    actorId: payment.userId,
    action: AUDIT_ACTIONS.WALLET_TOPUP_VERIFIED,
    entityType: "payment",
    entityId: payment.id,
    newValue: {
      amountPaise: payment.amountPaise,
      gatewayPaymentId: gateway.gatewayPaymentId,
    },
  });

  await notify({
    userId: payment.userId,
    type: NOTIFICATION_TYPES.WALLET_TOPUP_SUCCESS,
    title: "Wallet topped up",
    body: `₹${(payment.amountPaise / 100).toFixed(2)} has been added to your wallet.`,
    actionUrl: "/wallet",
  });

  // SM-004: a top-up that now covers the next deliveries clears "renewal
  // pending — payment due" at once. Imported lazily (subscriptions → wallet →
  // payments would otherwise be a cycle); never affects the credit above.
  await import("./subscription-renewal")
    .then(({ refreshPaymentDue }) => refreshPaymentDue(payment.userId))
    .catch((error) => console.error("[subscriptions] payment-due refresh failed", payment.userId, error));

  // Voucher bonus is opportunistic, not guaranteed (§19): a voucher that
  // expired or hit its budget in the seconds between checkout and this
  // callback must never claw back or block the real TOP_UP above — the
  // customer already paid. Failure here is caught and reported as "no bonus",
  // never surfaced as a payment failure.
  let voucherBonusPaise = 0;
  if (payment.voucherCode) {
    try {
      const wallet = await getOrCreateWallet(payment.userId);
      const redemption = await redeemVoucher({
        code: payment.voucherCode,
        userId: payment.userId,
        walletId: wallet.id,
        topupAmountPaise: payment.amountPaise,
        paymentId: payment.id,
      });
      if (redemption.status === "APPLIED" && redemption.bonusAmountPaise > 0) {
        await applyWalletMutation({
          userId: payment.userId,
          amountPaise: redemption.bonusAmountPaise,
          type: "PROMOTIONAL_CREDIT",
          idempotencyKey: `voucher-credit:${redemption.id}`,
          description: `Voucher bonus (${payment.voucherCode})`,
          paymentId: payment.id,
          voucherRedemptionId: redemption.id,
        });
        voucherBonusPaise = redemption.bonusAmountPaise;
      }
    } catch (error) {
      console.error("[vouchers] bonus not applied for payment", payment.id, error);
    }
  }

  const finalWallet = await db.query.wallets.findFirst({
    where: (w, { eq: equals }) => equals(w.userId, payment.userId),
  });

  return {
    payment: verified,
    balancePaise: finalWallet?.balancePaise ?? result.balancePaise,
    alreadyProcessed: result.deduplicated,
    voucherBonusPaise,
  };
}

/**
 * Server-to-server confirmation path (§3, §4) — the safety net for when a
 * customer's browser never calls `verifyAndCreditTopUp` (closed tab, network
 * drop after paying). The webhook's OWN signature over the raw request body
 * is what authenticates this call — the route handler verifies it before
 * this function is ever reached.
 */
export async function creditFromWebhook(
  gatewayOrderId: string,
  gatewayPaymentId: string,
): Promise<VerifyTopUpResult | null> {
  const payment = await db.query.payments.findFirst({
    where: eq(payments.gatewayOrderId, gatewayOrderId),
  });
  if (!payment) return null; // Not one of ours (or a different purpose) — ignore, not an error.

  if (payment.status === "SUCCESS") {
    const wallet = await db.query.wallets.findFirst({
      where: (w, { eq: equals }) => equals(w.userId, payment.userId),
    });
    return {
      payment,
      balancePaise: wallet?.balancePaise ?? 0,
      alreadyProcessed: true,
      voucherBonusPaise: 0,
    };
  }
  if (payment.status === "REFUNDED" || payment.status === "FAILED") return null;

  return finalizeVerifiedPayment(payment, {
    gatewayPaymentId,
    gatewaySignature: null,
  });
}

/**
 * HMAC-SHA256 over `order_id|payment_id`, keyed on the mock secret. This is
 * NOT how Cashfree does live verification (see `confirmCashfreeOrderPaid`) —
 * it exists purely so MOCK-mode payments (no real gateway to ask) still go
 * through genuine signature verification rather than an unconditional credit.
 * Compared in constant time to avoid leaking the expected digest by timing.
 */
export function verifyMockSignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHmac("sha256", MOCK_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies a Cashfree webhook body: `HMAC-SHA256(timestamp + rawBody)`,
 * base64-encoded, keyed on the same client secret used to authenticate API
 * calls (Cashfree has no separate webhook-only secret). The timestamp is
 * folded into the signed message — not just compared for freshness — so a
 * replayed-with-a-new-timestamp forgery still fails signature verification.
 */
export function verifyWebhookSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  const secret = getEnv().CASHFREE_SECRET_KEY;
  if (!secret) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Development/test secret. Only ever used in MOCK mode, so the mock flow
 * still exercises genuine HMAC verification rather than skipping the check
 * entirely.
 */
const MOCK_SECRET = "mock_cashfree_secret";

/** Produces a valid signature for the mock gateway (dev and tests only). */
export function signForMock(orderId: string, paymentId: string): string {
  if (isPaymentGatewayLive()) {
    throw new Error("signForMock must not be used with live credentials.");
  }
  return crypto
    .createHmac("sha256", MOCK_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
}

const CASHFREE_API_VERSION = "2023-08-01";

function cashfreeHeaders(): Record<string, string> {
  const env = getEnv();
  return {
    "Content-Type": "application/json",
    "x-api-version": CASHFREE_API_VERSION,
    "x-client-id": env.CASHFREE_APP_ID!,
    "x-client-secret": env.CASHFREE_SECRET_KEY!,
  };
}

async function createCashfreeOrder(
  amountPaise: number,
  userId: string,
): Promise<{ gatewayOrderId: string; paymentSessionId: string }> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw notFound("User");

  const orderId = `topup_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const response = await fetch(`${cashfreeApiBase()}/orders`, {
    method: "POST",
    headers: cashfreeHeaders(),
    body: JSON.stringify({
      order_id: orderId,
      // Cashfree takes order_amount in rupees, not paise.
      order_amount: amountPaise / 100,
      order_currency: "INR",
      customer_details: {
        customer_id: userId,
        customer_email: user.email,
        // Cashfree requires a phone number; fall back to a placeholder for
        // customers who never supplied one (the checkout modal itself does
        // not depend on it being real, unlike SMS-based UPI collect flows).
        customer_phone: user.phone ?? "9999999999",
      },
    }),
  });

  if (!response.ok) {
    console.error("[cashfree] order creation failed", response.status, await response.text());
    throw new Error("Could not start the payment with Cashfree.");
  }

  const order = (await response.json()) as {
    order_id: string;
    payment_session_id: string;
  };
  return { gatewayOrderId: order.order_id, paymentSessionId: order.payment_session_id };
}

/**
 * Server-to-server proof of payment for the client-invoked verify path
 * (`verifyAndCreditTopUp`). Calls Cashfree's "Get Payments for an Order" API
 * and looks for an attempt with `payment_status === "SUCCESS"` — this is the
 * one thing in the whole flow that is never taken on the client's word.
 */
async function confirmCashfreeOrderPaid(
  gatewayOrderId: string,
): Promise<{ cfPaymentId: string } | null> {
  const response = await fetch(`${cashfreeApiBase()}/orders/${gatewayOrderId}/payments`, {
    method: "GET",
    headers: cashfreeHeaders(),
  });

  if (!response.ok) {
    console.error(
      "[cashfree] payment status check failed",
      gatewayOrderId,
      response.status,
      await response.text(),
    );
    return null;
  }

  const attempts = (await response.json()) as Array<{
    cf_payment_id: string;
    payment_status: string;
  }>;
  const successful = attempts.find((a) => a.payment_status === "SUCCESS");
  return successful ? { cfPaymentId: String(successful.cf_payment_id) } : null;
}

export async function listPayments(userId: string): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(payments.createdAt);
}
