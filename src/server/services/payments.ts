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

import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";

import { cashfreeApiBase, cashfreeEnvProblem, getEnv, isPaymentGatewayLive } from "@/lib/env";
import {
  conflict,
  notFound,
  paymentVerificationFailed,
  validationFailed,
} from "@/lib/errors";
import { db } from "@/server/db";
import { payments, users, type Payment } from "@/server/db/schema";
import { assertCashfreeEnvSafe, cashfreeNotifyUrl, cashfreeOrderExpiry } from "@/server/payments/cashfree-env";
import { checkRiskForUser } from "./risk";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { getOrCreateWallet, applyWalletMutation } from "./wallet";
import { creditShopWalletTopUp, getShopWalletBalance } from "./shop-wallet";
import { previewVoucher, redeemVoucher } from "./vouchers";
import { getRule } from "./settings";

/** Minimum / maximum top-up, in paise: live values are rule `walletTopup` (defaults ₹1 and ₹1,00,000). */
const rupees = (paise: number) => (paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });

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
  const topupLimits = await getRule("walletTopup");
  if (amountPaise < topupLimits.minPaise) {
    throw validationFailed(`The minimum top-up is ₹${rupees(topupLimits.minPaise)}.`);
  }
  if (amountPaise > topupLimits.maxPaise) {
    throw validationFailed(`The maximum top-up is ₹${rupees(topupLimits.maxPaise)}.`);
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

/**
 * A shop owner's wallet recharge (rule shopWallet). The same gateway flow as a
 * customer top-up: this moves NO money; the shop wallet is credited only by
 * the verify step / webhook once Cashfree itself confirms the payment.
 */
export async function createShopWalletTopUpOrder(
  shopId: string,
  userId: string,
  amountPaise: number,
): Promise<CreateTopUpResult> {
  if (!Number.isInteger(amountPaise)) {
    throw validationFailed("Amount must be a whole number of paise.");
  }
  const rules = await getRule("shopWallet");
  if (!rules.enabled) throw conflict("Shop wallets are not switched on yet.");
  if (amountPaise < rules.topupMinPaise) {
    throw validationFailed(`The minimum recharge is ₹${rupees(rules.topupMinPaise)}.`);
  }
  if (amountPaise > rules.topupMaxPaise) {
    throw validationFailed(`The maximum recharge is ₹${rupees(rules.topupMaxPaise)}.`);
  }

  const live = isPaymentGatewayLive();
  let gatewayOrderId: string;
  let paymentSessionId: string | null = null;
  if (live) {
    const order = await createCashfreeOrder(amountPaise, userId, "shoptopup");
    gatewayOrderId = order.gatewayOrderId;
    paymentSessionId = order.paymentSessionId;
  } else {
    gatewayOrderId = `mock_order_${crypto.randomUUID()}`;
  }

  const [payment] = await db
    .insert(payments)
    .values({
      userId,
      shopId,
      gateway: live ? "CASHFREE" : "MOCK",
      gatewayOrderId,
      amountPaise,
      currency: "INR",
      status: "CREATED",
      purpose: "SHOP_WALLET_TOPUP",
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
    voucherPreview: null,
  };
}

/** The balance a settled payment credited: the shop's wallet for a shop recharge, else the payer's. */
async function settledBalancePaise(payment: Payment): Promise<number> {
  if (payment.purpose === "SHOP_WALLET_TOPUP" && payment.shopId) return getShopWalletBalance(payment.shopId);
  const wallet = await db.query.wallets.findFirst({
    where: (w, { eq: equals }) => equals(w.userId, payment.userId),
  });
  return wallet?.balancePaise ?? 0;
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
    return {
      payment,
      alreadySettled: {
        payment,
        balancePaise: await settledBalancePaise(payment),
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
  let loaded: Awaited<ReturnType<typeof loadVerifiablePayment>>;
  try {
    loaded = await loadVerifiablePayment(input.userId, input.gatewayOrderId);
  } catch (error) {
    // docs/payments-cashfree-audit-2026-11: the customer's own top-up, marked
    // FAILED earlier, that Cashfree now reports paid — credited, not refused.
    const failed = await db.query.payments.findFirst({ where: eq(payments.gatewayOrderId, input.gatewayOrderId) });
    if (failed && failed.userId === input.userId && failed.status === "FAILED" && failed.gateway === "CASHFREE") {
      const recovered = await recoverLateTopUp(failed).catch((cause: unknown) => {
        console.error("[cashfree] late top-up check failed", input.gatewayOrderId, cause);
        return null;
      });
      if (recovered) return recovered;
    }
    throw error;
  }
  const { payment, alreadySettled } = loaded;
  if (alreadySettled) return alreadySettled;

  // TC-PAY-004: a MOCK top-up (or any, while no Cashfree keys are set) has no
  // Cashfree order to ask — never call Cashfree then. The payment is simply
  // not confirmed (400), and is left open for the mock settle step.
  if (payment.gateway !== "CASHFREE" || !isPaymentGatewayLive()) {
    throw paymentVerificationFailed("This payment has not been completed, so nothing was added to your wallet.");
  }

  let state: CashfreeTopUpState;
  try {
    state = await cashfreeTopUpState(input.gatewayOrderId, payment.amountPaise);
  } catch (error) {
    // Cashfree could not be reached (network, DNS, its own 5xx): the payment's
    // state is unknown, so it is not marked FAILED — the customer (or the
    // webhook) can confirm it again. A 400, never a 500.
    console.error("[cashfree] payment status check unreachable", input.gatewayOrderId, error);
    throw paymentVerificationFailed("We could not reach the payment provider to confirm this payment. Please try again in a minute.");
  }
  // docs/payments-cashfree-audit-2026-11: a UPI / bank payment still PENDING at
  // Cashfree (or not attempted yet) is left open, not FAILED — the webhook or
  // the payments-reconcile job credits it once the bank confirms.
  if (state.kind === "PENDING") {
    throw paymentVerificationFailed(
      "Your bank has not confirmed this payment yet. If money was taken, your wallet is credited automatically as soon as it confirms — please do not pay again.",
    );
  }
  if (state.kind === "MISMATCH") {
    await markTopUpAmountMismatch(payment, state);
    throw paymentVerificationFailed();
  }
  const confirmed = state.kind === "PAID" ? { cfPaymentId: state.cfPaymentId } : null;
  if (!confirmed) {
    await db
      .update(payments)
      .set({
        status: "FAILED",
        failureReason: "Cashfree did not confirm payment for this order",
        updatedAt: new Date(),
      })
      .where(eq(payments.id, payment.id));
    // Event layer: a failed payment is checked against the risk rules now.
    await checkRiskForUser(payment.userId, "PAYMENT_FAILED");
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
    await checkRiskForUser(payment.userId, "PAYMENT_FAILED");
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
    return {
      payment: settled ?? payment,
      balancePaise: await settledBalancePaise(payment),
      alreadyProcessed: true,
      voucherBonusPaise: 0,
    };
  }

  // A shop wallet recharge credits the shop's prepaid wallet — same
  // guarantees: keyed on the gateway payment id, so it lands once.
  if (verified.purpose === "SHOP_WALLET_TOPUP" && verified.shopId) {
    const credited = await creditShopWalletTopUp({
      shopId: verified.shopId,
      paymentId: verified.id,
      gatewayPaymentId: gateway.gatewayPaymentId,
      amountPaise: verified.amountPaise,
      userId: verified.userId,
    });
    return {
      payment: verified,
      balancePaise: credited.balancePaise,
      alreadyProcessed: credited.deduplicated,
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
  /** What the signed webhook says was paid (rupees, as Cashfree sends it); checked when given. */
  observed?: { paymentAmount?: number | null; currency?: string | null },
): Promise<VerifyTopUpResult | null> {
  const payment = await db.query.payments.findFirst({
    where: eq(payments.gatewayOrderId, gatewayOrderId),
  });
  if (!payment) return null; // Not one of ours (or a different purpose) — ignore, not an error.

  if (payment.status === "SUCCESS") {
    return {
      payment,
      balancePaise: await settledBalancePaise(payment),
      alreadyProcessed: true,
      voucherBonusPaise: 0,
    };
  }
  if (payment.status === "REFUNDED") return null;

  // docs/payments-cashfree-audit-2026-11: never credit more than Cashfree says was paid.
  const mismatch = amountMismatch(payment.amountPaise, observed?.paymentAmount ?? null, observed?.currency ?? null);
  if (mismatch) {
    await markTopUpAmountMismatch(payment, { kind: "MISMATCH", cfPaymentId: gatewayPaymentId, paidPaise: mismatch.paidPaise, currency: mismatch.currency });
    return null;
  }

  if (payment.status === "FAILED") {
    // A payment we had given up on (the customer's check came back before the
    // bank confirmed) that Cashfree now reports paid: the customer's money
    // arrived, so it is credited — after Cashfree's own API confirms it.
    return recoverLateTopUp(payment);
  }

  return finalizeVerifiedPayment(payment, {
    gatewayPaymentId,
    gatewaySignature: null,
  });
}

/* ------------------------------------------- docs/payments-cashfree-audit-2026-11 */

/** Cashfree's answer about one top-up order, from its Get Payments API. */
type CashfreeTopUpState =
  | { kind: "PAID"; cfPaymentId: string }
  /** attempted: a payment attempt exists and is pending at the bank (false: nobody has paid yet). */
  | { kind: "PENDING"; attempted: boolean }
  | { kind: "FAILED" }
  | { kind: "MISMATCH"; cfPaymentId: string; paidPaise: number | null; currency: string | null };

const PENDING_ATTEMPT_STATUSES = new Set(["PENDING", "NOT_ATTEMPTED", "FLAGGED"]);

/**
 * Less money than the top-up (or a currency other than INR) → the mismatch;
 * null when it is fine. More than the top-up (a convenience fee the customer
 * paid on top) is fine: the wallet gets the top-up amount.
 */
function amountMismatch(expectedPaise: number, paidRupees: number | string | null, currency: string | null): { paidPaise: number | null; currency: string | null } | null {
  const currencyBad = currency != null && currency !== "" && currency.toUpperCase() !== "INR";
  const paidPaise = paidRupees == null || paidRupees === "" ? null : Math.round(Number(paidRupees) * 100);
  const amountBad = paidPaise != null && (!Number.isFinite(paidPaise) || paidPaise < expectedPaise);
  return currencyBad || amountBad ? { paidPaise: Number.isFinite(paidPaise) ? paidPaise : null, currency } : null;
}

/**
 * Asks Cashfree (server to server) for an order's payment attempts and sorts
 * them into paid / still pending / failed. Throws when Cashfree cannot be
 * reached or answers 5xx (the state is then unknown).
 */
async function cashfreeTopUpState(gatewayOrderId: string, expectedPaise: number): Promise<CashfreeTopUpState> {
  const response = await fetch(`${cashfreeApiBase()}/orders/${encodeURIComponent(gatewayOrderId)}/payments`, {
    method: "GET",
    headers: cashfreeHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status >= 500) {
    throw new Error(`Cashfree answered ${response.status} for order ${gatewayOrderId}`);
  }
  if (!response.ok) {
    console.error("[cashfree] payment status check failed", gatewayOrderId, response.status, await response.text());
    return { kind: "FAILED" };
  }
  const attempts = (await response.json()) as Array<{
    cf_payment_id: string | number;
    payment_status: string;
    payment_amount?: number | string | null;
    payment_currency?: string | null;
  }>;
  const list = Array.isArray(attempts) ? attempts : [];
  const successful = list.find((a) => a.payment_status === "SUCCESS");
  if (successful) {
    const mismatch = amountMismatch(expectedPaise, successful.payment_amount ?? null, successful.payment_currency ?? null);
    if (mismatch) return { kind: "MISMATCH", cfPaymentId: String(successful.cf_payment_id), ...mismatch };
    return { kind: "PAID", cfPaymentId: String(successful.cf_payment_id) };
  }
  if (list.some((a) => PENDING_ATTEMPT_STATUSES.has(a.payment_status) && a.payment_status !== "NOT_ATTEMPTED")) return { kind: "PENDING", attempted: true };
  if (list.length === 0 || list.every((a) => a.payment_status === "NOT_ATTEMPTED")) return { kind: "PENDING", attempted: false };
  return { kind: "FAILED" };
}

async function markTopUpAmountMismatch(payment: Payment, state: Extract<CashfreeTopUpState, { kind: "MISMATCH" }>): Promise<void> {
  const reason = `Cashfree reported ${state.paidPaise ?? "?"} paise ${state.currency ?? ""} for a ${payment.amountPaise} paise top-up; nothing was credited`.replace(/\s+/g, " ");
  const [flagged] = await db
    .update(payments)
    .set({ status: "FAILED", failureReason: reason, updatedAt: new Date() })
    .where(and(eq(payments.id, payment.id), inArray(payments.status, ["CREATED", "FAILED"])))
    .returning();
  if (!flagged) return;
  console.error("[cashfree] top-up amount mismatch", payment.gatewayOrderId, reason);
  await recordAudit({
    actorId: payment.userId,
    action: AUDIT_ACTIONS.WALLET_TOPUP_AMOUNT_MISMATCH,
    entityType: "payment",
    entityId: payment.id,
    newValue: { gatewayOrderId: payment.gatewayOrderId, cfPaymentId: state.cfPaymentId, paidPaise: state.paidPaise, currency: state.currency, amountPaise: payment.amountPaise },
  });
}

/**
 * A FAILED (or long-open) Cashfree top-up that Cashfree's own API now reports
 * paid: reopened and credited through the one finalize path. Null when
 * Cashfree does not confirm it (nothing changes).
 */
async function recoverLateTopUp(payment: Payment): Promise<VerifyTopUpResult | null> {
  if (payment.gateway !== "CASHFREE" || !isPaymentGatewayLive()) return null;
  const state = await cashfreeTopUpState(payment.gatewayOrderId, payment.amountPaise);
  if (state.kind === "MISMATCH") {
    await markTopUpAmountMismatch(payment, state);
    return null;
  }
  if (state.kind !== "PAID") return null;
  let open = payment;
  if (payment.status === "FAILED") {
    const [reopened] = await db
      .update(payments)
      .set({ status: "CREATED", failureReason: null, updatedAt: new Date() })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "FAILED")))
      .returning();
    if (!reopened) {
      const now = await db.query.payments.findFirst({ where: eq(payments.id, payment.id) });
      if (!now || now.status !== "CREATED") return null;
      open = now;
    } else {
      open = reopened;
    }
  }
  const result = await finalizeVerifiedPayment(open, { gatewayPaymentId: state.cfPaymentId, gatewaySignature: null });
  if (!result.alreadyProcessed) {
    await recordAudit({
      actorId: payment.userId,
      action: AUDIT_ACTIONS.WALLET_TOPUP_LATE_SUCCESS,
      entityType: "payment",
      entityId: payment.id,
      newValue: { gatewayOrderId: payment.gatewayOrderId, cfPaymentId: state.cfPaymentId, previousStatus: payment.status, amountPaise: payment.amountPaise },
    });
  }
  return result;
}

export interface TopUpReconcileResult {
  checked: number;
  credited: number;
  failed: number;
  stillPending: number;
  errors: string[];
}

/**
 * Cron payments-reconcile: Cashfree top-ups (customer and shop wallet) still
 * open 10 minutes after they started, up to 3 days old, are checked with
 * Cashfree — the safety net for a webhook that never arrived and a customer
 * who closed the app before the check. Paid → credited (once, as always);
 * no payment and over an hour old → FAILED; pending → left for the next run.
 */
export async function reconcileCashfreeTopUps(now: Date = new Date()): Promise<TopUpReconcileResult> {
  const result: TopUpReconcileResult = { checked: 0, credited: 0, failed: 0, stillPending: 0, errors: [] };
  if (!isPaymentGatewayLive() || cashfreeEnvProblem("pg")) return result;
  const open = await db
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.gateway, "CASHFREE"),
        eq(payments.status, "CREATED"),
        lt(payments.createdAt, new Date(now.getTime() - 10 * 60_000)),
        gt(payments.createdAt, new Date(now.getTime() - 72 * 3600_000)),
      ),
    )
    .orderBy(desc(payments.createdAt))
    .limit(50);
  for (const payment of open) {
    result.checked += 1;
    try {
      const state = await cashfreeTopUpState(payment.gatewayOrderId, payment.amountPaise);
      if (state.kind === "PAID") {
        const settled = await finalizeVerifiedPayment(payment, { gatewayPaymentId: state.cfPaymentId, gatewaySignature: null });
        if (!settled.alreadyProcessed) {
          result.credited += 1;
          await recordAudit({
            actorId: payment.userId,
            action: AUDIT_ACTIONS.WALLET_TOPUP_LATE_SUCCESS,
            entityType: "payment",
            entityId: payment.id,
            newValue: { gatewayOrderId: payment.gatewayOrderId, cfPaymentId: state.cfPaymentId, previousStatus: "CREATED", source: "RECONCILE" },
          });
        }
      } else if (state.kind === "MISMATCH") {
        await markTopUpAmountMismatch(payment, state);
        result.failed += 1;
      } else if (state.kind === "FAILED" || payment.createdAt.getTime() < now.getTime() - 60 * 60_000) {
        if (state.kind === "PENDING" && state.attempted && payment.createdAt.getTime() > now.getTime() - 24 * 3600_000) {
          // A bank can take hours on a pending UPI payment: keep asking for a day.
          result.stillPending += 1;
          continue;
        }
        await db
          .update(payments)
          .set({ status: "FAILED", failureReason: "Cashfree reported no completed payment for this order", updatedAt: new Date() })
          .where(and(eq(payments.id, payment.id), eq(payments.status, "CREATED")));
        result.failed += 1;
      } else {
        result.stillPending += 1;
      }
    } catch (error) {
      result.errors.push(`payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

/**
 * HMAC-SHA256 over `order_id|payment_id`, keyed on the mock secret. This is
 * NOT how Cashfree does live verification (see `cashfreeTopUpState`) —
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
  prefix: "topup" | "shoptopup" = "topup",
): Promise<{ gatewayOrderId: string; paymentSessionId: string }> {
  // docs/payments-cashfree-audit-2026-11: never the sandbox on gokesari.com, never production on the test site.
  assertCashfreeEnvSafe("pg");
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw notFound("User");

  const orderId = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  // The webhook reaches this site even when no webhook is set in the Cashfree dashboard.
  const notifyUrl = cashfreeNotifyUrl("/api/webhooks/cashfree");
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
      ...(notifyUrl ? { order_meta: { notify_url: notifyUrl } } : {}),
      // An abandoned checkout stops being payable; payments-reconcile then closes it.
      order_expiry_time: cashfreeOrderExpiry(60),
    }),
    signal: AbortSignal.timeout(20_000),
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

export async function listPayments(userId: string): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(payments.createdAt);
}

/**
 * Confirms a shop wallet recharge for the shop it was started for. The
 * payment must have been started by this user for this shop; Cashfree's own
 * API is the proof of payment, exactly as for a customer top-up.
 */
export async function verifyShopWalletTopUp(input: {
  userId: string;
  shopId: string;
  gatewayOrderId: string;
}): Promise<VerifyTopUpResult> {
  const payment = await db.query.payments.findFirst({ where: eq(payments.gatewayOrderId, input.gatewayOrderId) });
  if (!payment || payment.purpose !== "SHOP_WALLET_TOPUP" || payment.shopId !== input.shopId) {
    throw notFound("Payment");
  }
  return verifyAndCreditTopUp({ userId: input.userId, gatewayOrderId: input.gatewayOrderId });
}
