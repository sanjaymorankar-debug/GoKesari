/**
 * PAY-2 (docs/payments-topups-via-intents-2026-11): wallet top-ups and shop
 * wallet recharges through payment intents — the same create path, webhook
 * (/api/webhooks/payments/<gateway>) and status lookup (reconcileIntent) as
 * every other online payment. Behind rule `topupPaymentIntents` (off by
 * default); with it off, nothing here runs and top-ups use the older Cashfree
 * flow in services/payments.ts exactly as before.
 *
 * The `payments` row stays the anchor of a top-up: the wallet ledger, voucher
 * redemptions and the finance reports point at it. A routed top-up has
 *
 *   payments.gateway          = "INTENT"            (the older Cashfree code ignores it)
 *   payments.gateway_order_id = intent.merchant_order_id
 *   payment_intents.purpose   = WALLET_TOPUP | SHOP_WALLET_TOPUP
 *   payment_intents.reference_id = payments.id
 *
 * The capture handler marks the payments row SUCCESS and credits the wallet
 * inside the capture transaction, so the intent and the money commit together.
 * Notifications, the voucher bonus and the subscription refresh run after the
 * commit. Every step is idempotent: the payments row moves CREATED → SUCCESS
 * once (conditional UPDATE), the wallet credit is keyed `topup:<payment id at
 * the gateway>` (shop: `shop-topup:<…>`).
 */
import crypto from "node:crypto";

import { and, eq, inArray, or } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { conflict, notFound, paymentVerificationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { paymentIntents, payments, users, walletTransactions, type Payment, type PaymentIntentRow } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";
import { createPaymentIntent, getPaymentIntentRow, redirectUrlOf, type PaymentIntentRef, type PaymentPurpose } from "./intents";
import type { AfterCommit } from "./purpose-handlers";

/** Marks a `payments` row whose gateway side is a payment intent. */
export const INTENT_ROUTED_GATEWAY = "INTENT";

export const TOPUP_PURPOSES: readonly PaymentPurpose[] = ["WALLET_TOPUP", "SHOP_WALLET_TOPUP"];

export function isTopUpPurpose(purpose: string): boolean {
  return (TOPUP_PURPOSES as readonly string[]).includes(purpose);
}

/** True when new top-ups go through payment intents (rule topupPaymentIntents). */
export async function topUpsUseIntents(): Promise<boolean> {
  return (await getRule("topupPaymentIntents")).enabled;
}

export interface IntentTopUpStart {
  payment: Payment;
  intent: PaymentIntentRef;
  /** Cashfree's checkout session (open the Cashfree SDK with it); null for other gateways. */
  paymentSessionId: string | null;
  /** Where to send the browser when there is no SDK session (the sandbox page, a hosted page). */
  redirectUrl: string | null;
}

/**
 * Opens a top-up as a payments row + a payment intent. Amount limits and the
 * voucher are checked by the caller (services/payments.ts) exactly as for the
 * older flow. The gateway call happens inside createPaymentIntent, outside any
 * transaction of ours.
 */
export async function startTopUpViaIntent(input: {
  userId: string;
  shopId?: string | null;
  amountPaise: number;
  voucherCode?: string | null;
}): Promise<IntentTopUpStart> {
  const user = await db.query.users.findFirst({ where: eq(users.id, input.userId) });
  if (!user) throw notFound("User");
  const purpose: PaymentPurpose = input.shopId ? "SHOP_WALLET_TOPUP" : "WALLET_TOPUP";
  const paymentId = crypto.randomUUID();

  // The intent's merchant order id is only known once it exists, so the row starts with a
  // placeholder of our own (unique: it carries the row id) and gets the real one below.
  const [payment] = await db
    .insert(payments)
    .values({
      id: paymentId,
      userId: input.userId,
      shopId: input.shopId ?? null,
      gateway: INTENT_ROUTED_GATEWAY,
      gatewayOrderId: `intent_pending_${paymentId}`,
      amountPaise: input.amountPaise,
      currency: "INR",
      status: "CREATED",
      purpose,
      voucherCode: input.voucherCode ?? null,
    })
    .returning();

  let created;
  try {
    created = await createPaymentIntent({
      purpose,
      referenceId: payment.id,
      userId: input.userId,
      amountPaise: input.amountPaise,
      customer: { id: input.userId, name: user.name ?? null, email: user.email, phone: user.phone ?? null },
      description: purpose === "SHOP_WALLET_TOPUP" ? "Shop wallet recharge" : "Wallet top-up",
      idempotencyKey: `topup:${payment.id}`,
      mode: "CHECKOUT",
    });
  } catch (error) {
    // No gateway order was opened (or it is unknown and the intent will expire): close the row.
    await db
      .update(payments)
      .set({ status: "FAILED", failureReason: "The payment could not be started", updatedAt: new Date() })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "CREATED")));
    throw error;
  }

  const row = (await getPaymentIntentRow(created.intent.id))!;
  const [linked] = await db
    .update(payments)
    .set({ gatewayOrderId: row.merchantOrderId, rawPayload: { intentId: row.id }, updatedAt: new Date() })
    .where(eq(payments.id, payment.id))
    .returning();

  const sdk = row.gateway === "CASHFREE" && row.checkoutKind === "SDK_SESSION" ? row.checkoutToken : null;
  return {
    payment: linked,
    intent: created.intent,
    paymentSessionId: sdk,
    redirectUrl: sdk ? null : redirectUrlOf(row),
  };
}

/** The intent of an intent-routed top-up (newest first, though there is only ever one). */
export async function intentForTopUp(payment: Pick<Payment, "id" | "purpose">): Promise<PaymentIntentRow | null> {
  const row = await db.query.paymentIntents.findFirst({
    where: and(eq(paymentIntents.referenceId, payment.id), inArray(paymentIntents.purpose, ["WALLET_TOPUP", "SHOP_WALLET_TOPUP"])),
  });
  return row ?? null;
}

/** The top-up intent behind a Cashfree order id (our merchant order id, which Cashfree uses as its order id). */
export async function topUpIntentForOrderId(gatewayOrderId: string): Promise<PaymentIntentRow | null> {
  const [row] = await db
    .select()
    .from(paymentIntents)
    .where(
      and(
        inArray(paymentIntents.purpose, ["WALLET_TOPUP", "SHOP_WALLET_TOPUP"]),
        or(
          eq(paymentIntents.merchantOrderId, gatewayOrderId),
          and(eq(paymentIntents.gateway, "CASHFREE"), eq(paymentIntents.gatewayOrderId, gatewayOrderId)),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Credits a top-up's payments row inside the caller's transaction: CREATED (or
 * FAILED, for a late capture) → SUCCESS, then the wallet. Returns the row when
 * this call moved it, null when it was already settled.
 */
async function creditTopUpRow(tx: DbClient, paymentId: string, gatewayPaymentId: string, allowFromFailed: boolean): Promise<Payment | null> {
  const from: Payment["status"][] = allowFromFailed ? ["CREATED", "FAILED"] : ["CREATED"];
  const [verified] = await tx
    .update(payments)
    .set({ gatewayPaymentId, status: "SUCCESS", failureReason: null, verifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(payments.id, paymentId), inArray(payments.status, from)))
    .returning();
  if (!verified) return null;

  if (verified.purpose === "SHOP_WALLET_TOPUP" && verified.shopId) {
    const { creditShopWalletTopUp } = await import("@/server/services/shop-wallet");
    await creditShopWalletTopUp(
      { shopId: verified.shopId, paymentId: verified.id, gatewayPaymentId, amountPaise: verified.amountPaise, userId: verified.userId },
      tx,
    );
    return verified;
  }

  const { applyWalletMutation, getOrCreateWallet } = await import("@/server/services/wallet");
  await getOrCreateWallet(verified.userId, tx);
  await applyWalletMutation(
    {
      userId: verified.userId,
      amountPaise: verified.amountPaise,
      type: "TOP_UP",
      idempotencyKey: `topup:${gatewayPaymentId}`,
      description: "Wallet top-up",
      paymentId: verified.id,
    },
    tx,
  );
  await recordAudit(
    {
      actorId: verified.userId,
      action: AUDIT_ACTIONS.WALLET_TOPUP_VERIFIED,
      entityType: "payment",
      entityId: verified.id,
      newValue: { amountPaise: verified.amountPaise, gatewayPaymentId, via: "payment_intent" },
    },
    tx,
  );
  return verified;
}

/** After the commit: tell the customer, apply a voucher bonus, clear "payment due" on subscriptions. */
async function afterCustomerTopUp(payment: Payment): Promise<void> {
  const { NOTIFICATION_TYPES, notify } = await import("@/server/services/notifications");
  await notify({
    userId: payment.userId,
    type: NOTIFICATION_TYPES.WALLET_TOPUP_SUCCESS,
    title: "Wallet topped up",
    body: `₹${(payment.amountPaise / 100).toFixed(2)} has been added to your wallet.`,
    actionUrl: "/wallet",
  }).catch((error) => console.error("[topup-intents] notification failed", payment.id, error));

  await import("@/server/services/subscription-renewal")
    .then(({ refreshPaymentDue }) => refreshPaymentDue(payment.userId))
    .catch((error) => console.error("[subscriptions] payment-due refresh failed", payment.userId, error));

  // Opportunistic, exactly as in the older flow: a voucher that expired meanwhile never blocks the top-up.
  if (!payment.voucherCode) return;
  try {
    const { applyWalletMutation, getOrCreateWallet } = await import("@/server/services/wallet");
    const { redeemVoucher } = await import("@/server/services/vouchers");
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
    }
  } catch (error) {
    console.error("[vouchers] bonus not applied for payment", payment.id, error);
  }
}

function gatewayPaymentIdOf(intent: Pick<PaymentIntentRef, "id" | "gatewayPaymentId">): string {
  // A gateway always reports a payment id for a capture; the fallback only keeps the key unique.
  return intent.gatewayPaymentId ?? `intent:${intent.id}`;
}

/** CAPTURED_HANDLERS.WALLET_TOPUP / SHOP_WALLET_TOPUP. */
export async function onTopUpCaptured(intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit): Promise<void> {
  const credited = await creditTopUpRow(client, intent.referenceId, gatewayPaymentIdOf(intent), false);
  if (credited && credited.purpose === "WALLET_TOPUP") {
    const run = () => afterCustomerTopUp(credited);
    if (afterCommit) afterCommit(run);
    else await run();
  }
}

/** PAYMENT_ENDED_HANDLERS.WALLET_TOPUP / SHOP_WALLET_TOPUP: the payments row fails with the intent. */
export async function onTopUpEnded(intent: PaymentIntentRow, to: "FAILED" | "EXPIRED", client: DbClient): Promise<void> {
  await client
    .update(payments)
    .set({
      status: "FAILED",
      failureReason: to === "EXPIRED" ? "The payment was not completed in time" : (intent.failureReason ?? "The payment failed at the gateway"),
      updatedAt: new Date(),
    })
    .where(and(eq(payments.id, intent.referenceId), eq(payments.status, "CREATED")));
}

/**
 * LATE_CAPTURE_HANDLERS.WALLET_TOPUP / SHOP_WALLET_TOPUP: the gateway took the
 * money after the attempt had failed or expired. Unlike an order (whose stock
 * was released), a top-up can simply be credited — the customer paid — as the
 * older flow did (recoverLateTopUp). The intent itself stays ended; the
 * payments row and the wallet carry the money.
 */
export async function onTopUpLateCapture(
  intent: PaymentIntentRow,
  captured: { amountPaise: number; gatewayPaymentId: string | null },
  client: DbClient,
  afterCommit: AfterCommit,
): Promise<boolean> {
  if (captured.amountPaise !== intent.amountPaise) return false;
  const credited = await creditTopUpRow(client, intent.referenceId, captured.gatewayPaymentId ?? `intent:${intent.id}`, true);
  if (!credited) {
    // Already credited by an earlier report of the same late payment: handled, nothing for support.
    const [row] = await client.select({ status: payments.status }).from(payments).where(eq(payments.id, intent.referenceId));
    return row?.status === "SUCCESS";
  }
  await recordAudit(
    {
      actorId: credited.userId,
      action: AUDIT_ACTIONS.WALLET_TOPUP_LATE_SUCCESS,
      entityType: "payment",
      entityId: credited.id,
      newValue: { intentId: intent.id, gatewayPaymentId: captured.gatewayPaymentId, previousIntentStatus: intent.status, via: "payment_intent" },
    },
    client,
  );
  if (credited.purpose === "WALLET_TOPUP") afterCommit(() => afterCustomerTopUp(credited));
  return true;
}

export interface IntentTopUpStatus {
  payment: Payment;
  /** The intent's status after asking the gateway. */
  status: PaymentIntentRow["status"];
  voucherBonusPaise: number;
}

/**
 * The status lookup for a routed top-up: asks the gateway through the one
 * intent path (reconcileIntent — the capture handler credits the wallet) and
 * reads the result back. Nothing the caller sends is trusted.
 */
export async function confirmTopUpViaIntent(payment: Payment): Promise<IntentTopUpStatus> {
  const intent = await intentForTopUp(payment);
  if (!intent) throw notFound("Payment");
  // FAILED too: money that arrived after the attempt ended is credited (onTopUpLateCapture).
  if (payment.status === "CREATED" || payment.status === "FAILED") {
    const { reconcileIntent } = await import("./processing");
    try {
      await reconcileIntent(intent.id, "API");
    } catch (error) {
      console.error("[topup-intents] status check unreachable", intent.id, error);
      throw paymentVerificationFailed("We could not reach the payment provider to confirm this payment. Please try again in a minute.");
    }
  }
  const [now] = await db.select().from(payments).where(eq(payments.id, payment.id));
  const latest = (await getPaymentIntentRow(intent.id))!;
  const bonus = await db
    .select({ amountPaise: walletTransactions.amountPaise })
    .from(walletTransactions)
    .where(and(eq(walletTransactions.paymentId, payment.id), eq(walletTransactions.type, "PROMOTIONAL_CREDIT")));
  return { payment: now, status: latest.status, voucherBonusPaise: bonus.reduce((n, r) => n + Number(r.amountPaise), 0) };
}

/** Throws the customer-facing error for a routed top-up that has not been paid (yet). */
export function assertTopUpPaid(status: IntentTopUpStatus): void {
  if (status.payment.status === "SUCCESS") return;
  if (status.payment.status === "FAILED" || status.payment.status === "REFUNDED") {
    throw conflict("This payment can no longer be completed.");
  }
  throw paymentVerificationFailed(
    "Your bank has not confirmed this payment yet. If money was taken, your wallet is credited automatically as soon as it confirms — please do not pay again.",
  );
}

/** Which Cashfree environment the browser's SDK should talk to. */
export function cashfreeMode(): "sandbox" | "production" {
  return getEnv().CASHFREE_ENV;
}
