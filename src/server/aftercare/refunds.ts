/**
 * F6.2.3 (GS-073) — order refunds with an itemised breakdown and the
 * customer's choice of where the money goes.
 *
 *   refund = amount paid − applicable deductions
 *            (after-packing fee F6.1.3; delivery fee kept on a customer's own
 *             cancel after dispatch — D10, unchanged)
 *
 *   WALLET   → instant, ledger-based (wallets + wallet_transactions); the
 *              wallet is created if the customer has none yet. Wallet-paid and
 *              cash orders always refund here.
 *   ORIGINAL → back to the original payment method through the gateway
 *              (payments/intents.ts refundPaymentIntent), for orders paid
 *              online while rule refundChoice.originalMethodEnabled is on.
 *
 * order_refunds records the choice and status (REQUESTED → PROCESSING →
 * SUCCESS | FAILED), order_refund_events the customer's timeline, and every
 * status reaches the customer by email and push (event order_refund.updated).
 * A part of an order that continues (a removed line, a cheaper substitute —
 * TC-PAY-029) is refunded the same way by refundOrderPart: one row per part.
 *
 * This module is imported by orders.ts (cancelOrder): it must not import it.
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { db, type DbClient } from "@/server/db";
import {
  financialAdjustments,
  orderCharges,
  orderRefundEvents,
  orderRefunds,
  orderStatusHistory,
  orders,
  shops,
  walletTransactions,
  type Order,
  type OrderRefund,
  type OrderStatus,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { findCapturedIntent, getPaymentIntent, refundPaymentIntent, type PaymentIntentRef } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { postLedger, postRetainedDeliveryFee } from "@/server/services/finance";
import { getRule } from "@/server/services/settings";
import { applyWalletMutation, getOrCreateWallet, refundOriginalDebit } from "@/server/services/wallet";
import { AFTER_PACKING_STATUSES, effectiveFeePolicy, feeFor, type FeeQuote } from "./cancellation-fee";
import { recordOrderStatusEvent } from "@/server/events/order-status-record";

type Actor = { id: string; role: UserRole } | null;

export type RefundMethod = "WALLET" | "ORIGINAL";
export type PaymentChannel = "WALLET" | "ONLINE" | "COD";
export type RefundStatus = OrderRefund["status"];

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  REQUESTED: "requested",
  PROCESSING: "processing",
  SUCCESS: "completed",
  FAILED: "failed",
};

export interface BreakdownLine {
  code: string;
  label: string;
  amountPaise: number;
  note?: string;
}

export interface RefundBreakdown {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  paymentChannel: PaymentChannel;
  /** The order counts as paid (money is held for it). */
  paid: boolean;
  /** What the customer paid that is still held (earlier part-refunds already taken off). */
  paidPaise: number;
  /** How the amount paid is made up (items, delivery fee, taxes, discount). */
  paidLines: BreakdownLine[];
  deductions: BreakdownLine[];
  deductionsPaise: number;
  refundPaise: number;
  stage: "BEFORE_PACKING" | "AFTER_PACKING" | "AFTER_DISPATCH" | "OTHER";
  /** The after-packing fee's working (for the order ledger), when one applies. */
  fee: FeeQuote | null;
}

/* ------------------------------------------------------------- reading */

const PAID_STATUSES: readonly OrderStatus[] = [
  "CONFIRMED",
  "ACCEPTED",
  "PREPARING",
  "READY",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "FAILED",
  "RETURNED",
  "DELIVERED",
  "DISPUTED",
];

/** The latest captured gateway payment for an order, or null (also while the payments workstream is not merged). */
export async function capturedIntentFor(
  orderId: string,
  client: DbClient = db,
  orderGroupId: string | null = null,
): Promise<PaymentIntentRef | null> {
  try {
    // A multi-shop online cart is paid by one ORDER_GROUP intent (WS-A); each
    // shop's order is refunded from it (partial refunds of the group payment).
    return (
      (await findCapturedIntent("ORDER", orderId, client)) ??
      (orderGroupId ? await findCapturedIntent("ORDER_GROUP", orderGroupId, client) : null)
    );
  } catch {
    return null;
  }
}

async function walletDebitFor(order: Pick<Order, "id" | "userId">, client: DbClient) {
  const [row] = await client
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.orderId, order.id),
        eq(walletTransactions.userId, order.userId),
        sql`${walletTransactions.amountPaise} < 0`,
      ),
    )
    .limit(1);
  return row ?? null;
}

/** How the order was paid. A wallet debit wins; then a captured gateway payment; COD is COD. */
export async function paymentChannelFor(
  order: Pick<Order, "id" | "userId" | "paymentMethod"> & Partial<Pick<Order, "orderGroupId">>,
  client: DbClient = db,
): Promise<{ channel: PaymentChannel; intent: PaymentIntentRef | null; hasWalletDebit: boolean }> {
  if (order.paymentMethod === "COD") return { channel: "COD", intent: null, hasWalletDebit: false };
  if (await walletDebitFor(order, client)) return { channel: "WALLET", intent: null, hasWalletDebit: true };
  const intent = await capturedIntentFor(order.id, client, order.orderGroupId ?? null);
  return { channel: intent ? "ONLINE" : "WALLET", intent, hasWalletDebit: false };
}

function paidLinesFor(order: Order): BreakdownLine[] {
  const lines: BreakdownLine[] = [{ code: "ITEMS", label: "Items", amountPaise: order.subtotalPaise }];
  if (order.deliveryFeePaise > 0) lines.push({ code: "DELIVERY_FEE", label: "Delivery fee", amountPaise: order.deliveryFeePaise });
  if (order.taxPaise > 0) lines.push({ code: "TAX", label: "Taxes", amountPaise: order.taxPaise });
  if (order.discountPaise > 0) lines.push({ code: "DISCOUNT", label: "Discount", amountPaise: -order.discountPaise });
  const sum = lines.reduce((n, l) => n + l.amountPaise, 0);
  // Part-refunded or older orders: show the one figure that is certain.
  return sum === order.totalPaise ? lines : [{ code: "PAID", label: "Amount paid", amountPaise: order.totalPaise }];
}

/**
 * The itemised refund for cancelling an order now: what was paid, what is
 * kept and why, and what goes back. Used by the cancellation quote and,
 * under the order's row lock, by the refund itself — so the customer is
 * refunded exactly what they were shown.
 */
export async function computeRefundBreakdown(
  orderOrId: string | Order,
  ctx: { selfService: boolean; client?: DbClient; channel?: PaymentChannel },
): Promise<RefundBreakdown> {
  const client = ctx.client ?? db;
  const order =
    typeof orderOrId === "string" ? await client.query.orders.findFirst({ where: eq(orders.id, orderOrId) }) : orderOrId;
  if (!order) throw notFound("Order");
  const channel = ctx.channel ?? (await paymentChannelFor(order, client)).channel;
  const paid = PAID_STATUSES.includes(order.status) && order.paidAt != null;
  const paidPaise = paid ? order.totalPaise : 0;

  const deductions: BreakdownLine[] = [];
  let fee: FeeQuote | null = null;
  let stage: RefundBreakdown["stage"] = "OTHER";
  if (["CONFIRMED", "ACCEPTED", "PREPARING"].includes(order.status)) stage = "BEFORE_PACKING";
  else if (AFTER_PACKING_STATUSES.includes(order.status)) stage = "AFTER_PACKING";
  else if (order.status === "PICKED_UP" || order.status === "OUT_FOR_DELIVERY") stage = "AFTER_DISPATCH";

  if (ctx.selfService && stage === "AFTER_DISPATCH" && paid) {
    // D10, unchanged: the customer's own cancel after dispatch keeps the delivery fee.
    const kept = order.totalPaise - order.subtotalPaise;
    if (kept > 0) {
      deductions.push({
        code: "DELIVERY_FEE_RETAINED",
        label: "Delivery fee (the order was already on its way)",
        amountPaise: kept,
      });
    }
  } else if (ctx.selfService && stage === "AFTER_PACKING" && (await getRule("afterPackingCancellation")).enabled) {
    const policy = await effectiveFeePolicy(order.shopId, client);
    fee = feeFor(policy, { subtotalPaise: order.subtotalPaise, paidPaise });
    if (fee.amountPaise > 0) {
      deductions.push({
        code: "AFTER_PACKING_FEE",
        label: "Cancellation fee (the order was already packed)",
        amountPaise: fee.amountPaise,
        note:
          fee.basis.feeType === "PERCENT"
            ? `${(fee.basis.feeBp / 100).toFixed(2)}% of the items, at most ${formatPaise(fee.basis.capPaise)}`
            : undefined,
      });
    }
  }
  const deductionsPaise = Math.min(
    paidPaise,
    deductions.reduce((n, d) => n + d.amountPaise, 0),
  );
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentChannel: channel,
    paid,
    paidPaise,
    paidLines: paid ? paidLinesFor(order) : [],
    deductions,
    deductionsPaise,
    refundPaise: paidPaise - deductionsPaise,
    stage,
    fee,
  };
}

/** Where the refund may go for this order (wallet always; the original method only for online payments, when enabled). */
export async function refundMethodsFor(channel: PaymentChannel): Promise<RefundMethod[]> {
  if (channel !== "ONLINE") return ["WALLET"];
  // An order paid online came through a working gateway (rule onlinePayments),
  // so its money goes back there by default; the wallet stays the customer's
  // other choice. refundChoice.originalMethodEnabled still opens it on its own.
  const original =
    (await getRule("refundChoice")).originalMethodEnabled || (await getRule("onlinePayments")).enabled;
  return original ? ["ORIGINAL", "WALLET"] : ["WALLET"];
}

/* ------------------------------------------------------------- writing */

async function appendRefundEvent(
  tx: DbClient,
  refund: Pick<OrderRefund, "id" | "orderId">,
  status: RefundStatus,
  note: string,
  actorId: string | null,
): Promise<void> {
  await tx.insert(orderRefundEvents).values({ refundId: refund.id, orderId: refund.orderId, status, note, actorId });
}

async function announceRefund(
  tx: DbClient,
  refund: OrderRefund,
  orderNumber: string,
  detail: string,
  actor: Actor,
): Promise<void> {
  await emitEvent(
    {
      type: "order_refund.updated",
      subjectId: refund.id,
      orderId: refund.orderId,
      actor: actor ?? { id: null, role: null },
      idempotencyKey: `order_refund:${refund.id}:${refund.status}:${refund.method}`,
      payload: {
        refundId: refund.id,
        orderId: refund.orderId,
        orderNumber,
        buyerId: refund.userId,
        status: refund.status,
        statusLabel: REFUND_STATUS_LABELS[refund.status],
        amountLabel: formatPaise(refund.amountPaise),
        detail,
      },
    },
    tx,
  );
}

async function setOrderStatus(tx: DbClient, orderId: string, from: OrderStatus, to: OrderStatus, actorId: string | null, note: string) {
  await tx.update(orders).set({ status: to, updatedAt: new Date() }).where(eq(orders.id, orderId));
  await tx.insert(orderStatusHistory).values({ orderId, previousStatus: from, newStatus: to, changedBy: actorId, note });
  // Checked against the order state machine and logged as an event, like every other status change.
  await recordOrderStatusEvent(tx, orderId, from, to, actorId ? { id: actorId, role: null } : null, note);
}

const PART_KEY_PREFIX = "order-refund:part:";

/** The order_refunds key of a part refund (removed line, cheaper substitute) of a continuing order. */
function partRefundKey(orderId: string, key: string): string {
  return `${PART_KEY_PREFIX}${orderId}:${key}`;
}

/**
 * The wallet ledger key of a refund row. The cancellation keeps the key it
 * always had; a part refund (TC-PAY-029) gets the per-line key the shop's line
 * refunds have always used, so it can never collide with the cancellation's.
 */
function walletRefundKey(refund: Pick<OrderRefund, "orderId" | "idempotencyKey">): string {
  const part = `${PART_KEY_PREFIX}${refund.orderId}:`;
  return refund.idempotencyKey.startsWith(part)
    ? `refund:order:${refund.orderId}:${refund.idempotencyKey.slice(part.length)}`
    : `refund:order:${refund.orderId}`;
}

const isPartRefund = (refund: Pick<OrderRefund, "idempotencyKey">) => refund.idempotencyKey.startsWith(PART_KEY_PREFIX);

/** Credits the wallet for a refund row: restores the original debit's split, or a plain customer-funded credit. */
async function creditWallet(tx: DbClient, refund: OrderRefund, order: Order, actorId: string | null, description: string) {
  const key = walletRefundKey(refund);
  const hasDebit = await walletDebitFor(order, tx);
  if (hasDebit) {
    return refundOriginalDebit(
      {
        userId: order.userId,
        referenceType: "orderId",
        referenceId: order.id,
        idempotencyKey: key,
        description,
        createdBy: actorId,
        amountPaise: refund.amountPaise,
      },
      tx,
    );
  }
  // Paid online or in cash: there is no wallet debit to reverse. The wallet is
  // created first if the customer never had one.
  await getOrCreateWallet(order.userId, tx);
  return applyWalletMutation(
    {
      userId: order.userId,
      amountPaise: refund.amountPaise,
      type: "REFUND",
      idempotencyKey: key,
      description,
      orderId: order.id,
      createdBy: actorId,
      promotionalAmountPaise: 0,
    },
    tx,
  );
}

/**
 * The after-packing fee in the order ledger: an order_charges row, the
 * finance journal, and — when the fee is the shop's — a shop adjustment paid
 * in its next settlement. Idempotent per order.
 */
async function recordCancellationFee(
  tx: DbClient,
  order: Order,
  fee: FeeQuote,
  actor: Actor,
): Promise<void> {
  const { feeBeneficiary } = await getRule("afterPackingCancellation");
  const key = `order:${order.id}:after-packing-fee`;
  const [charge] = await tx
    .insert(orderCharges)
    .values({
      orderId: order.id,
      kind: "AFTER_PACKING_CANCELLATION_FEE",
      amountPaise: fee.amountPaise,
      beneficiary: feeBeneficiary,
      basis: fee.basis as unknown as Record<string, unknown>,
      idempotencyKey: key,
      createdBy: actor?.id ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (!charge) return;

  const base = { orderId: order.id, sourceType: "order_charges", sourceId: charge.id, entryType: "ADJUSTMENT" as const };
  // The platform holds the customer's money and keeps the fee from the refund...
  const lines: Parameters<typeof postLedger>[0] = [
    { ...base, entityType: "PLATFORM", direction: "CREDIT", amountPaise: fee.amountPaise, key: `${key}:platform` },
  ];
  if (feeBeneficiary === "SHOP") {
    // ...and owes it on to the shop, through the next settlement.
    const [adjustment] = await tx
      .insert(financialAdjustments)
      .values({
        type: "SHOP_ADJUSTMENT",
        party: "SHOP",
        status: "PENDING",
        shopId: order.shopId,
        orderId: order.id,
        amountPaise: fee.amountPaise,
        reason: `After-packing cancellation fee, order ${order.orderNumber}`,
        idempotencyKey: `${key}:adjustment`,
        createdBy: actor?.id ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (adjustment) {
      await tx.update(orderCharges).set({ financialAdjustmentId: adjustment.id }).where(eq(orderCharges.id, charge.id));
    }
    lines.push(
      { ...base, entityType: "SHOP", entityId: order.shopId, direction: "CREDIT", amountPaise: fee.amountPaise, key: `${key}:shop` },
      { ...base, entityType: "PLATFORM", direction: "DEBIT", amountPaise: fee.amountPaise, key: `${key}:platform-to-shop` },
    );
  }
  await postLedger(lines, actor?.id ?? null, tx);
  await recordAudit(
    {
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? null,
      action: AUDIT_ACTIONS.ORDER_CANCELLATION_FEE_CHARGED,
      entityType: "order",
      entityId: order.id,
      newValue: { amountPaise: fee.amountPaise, beneficiary: feeBeneficiary, basis: fee.basis },
    },
    tx,
  );
  const [shop] = await tx.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, order.shopId));
  await emitEvent(
    {
      type: "order.cancelled_after_packing",
      subjectId: order.id,
      orderId: order.id,
      actor: actor ?? { id: null, role: null },
      idempotencyKey: `order:${order.id}:cancelled-after-packing`,
      payload: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        shopOwnerId: shop?.ownerId ?? null,
        feeLabel: formatPaise(fee.amountPaise),
        beneficiary: feeBeneficiary,
      },
    },
    tx,
  );
}

export interface AftercarePlan {
  breakdown: RefundBreakdown;
  method: RefundMethod;
  intent: PaymentIntentRef | null;
}

/**
 * Whether a cancellation goes through the aftercare refund (this module)
 * instead of cancelOrder's original wallet refund. Null = the original path,
 * unchanged: only an after-packing cancel, a customer's explicit refund
 * choice, or an order paid online (which has no wallet debit to reverse)
 * comes here.
 */
export async function planCancellationRefund(
  tx: DbClient,
  order: Order,
  input: { selfService: boolean; afterPacking: boolean; refundMethod?: RefundMethod; expectedRefundPaise?: number },
): Promise<AftercarePlan | null> {
  const payment = await paymentChannelFor(order, tx);
  if (!input.afterPacking && !input.refundMethod && payment.channel !== "ONLINE") return null;
  const breakdown = await computeRefundBreakdown(order, { selfService: input.selfService, client: tx, channel: payment.channel });
  if (input.expectedRefundPaise !== undefined && input.expectedRefundPaise !== breakdown.refundPaise) {
    throw conflict("The refund amount has changed since you looked — please review it again.", {
      refundPaise: breakdown.refundPaise,
    });
  }
  const allowed = await refundMethodsFor(payment.channel);
  if (input.refundMethod === "ORIGINAL" && !allowed.includes("ORIGINAL")) {
    throw conflict("A refund to the original payment method is not available for this order — choose the wallet.");
  }
  const method: RefundMethod = input.refundMethod ?? allowed[0];
  return { breakdown, method, intent: payment.intent };
}

/**
 * Runs inside cancelOrder's transaction, after the order is CANCELLED:
 * records the fee, the refund and its first timeline steps. A wallet refund
 * completes here (order → REFUNDED); a refund to the original method is left
 * REQUESTED (order → REFUND_PENDING) for processOriginalRefund after commit.
 * Returns the order status it ended in.
 */
export async function executeCancellationRefund(
  tx: DbClient,
  order: Order,
  plan: AftercarePlan,
  input: { actor: Actor; reason: string },
): Promise<OrderStatus> {
  const { breakdown, method } = plan;
  const actorId = input.actor?.id ?? null;
  if (breakdown.fee && breakdown.fee.amountPaise > 0 && breakdown.paid) {
    await recordCancellationFee(tx, order, breakdown.fee, input.actor);
  }
  if (breakdown.deductions.some((d) => d.code === "DELIVERY_FEE_RETAINED")) {
    // D10, unchanged: the delivery fee that was not refunded is platform revenue.
    await postRetainedDeliveryFee(order, tx);
  }
  if (!breakdown.paid) return "CANCELLED";

  const [refund] = await tx
    .insert(orderRefunds)
    .values({
      orderId: order.id,
      userId: order.userId,
      method,
      paymentChannel: breakdown.paymentChannel,
      status: "REQUESTED",
      paidPaise: breakdown.paidPaise,
      deductionsPaise: breakdown.deductionsPaise,
      amountPaise: breakdown.refundPaise,
      breakdown: breakdown as unknown as Record<string, unknown>,
      reason: input.reason,
      gatewayIntentId: method === "ORIGINAL" ? plan.intent?.id ?? null : null,
      idempotencyKey: `order-refund:cancel:${order.id}`,
      requestedBy: actorId,
    })
    .onConflictDoNothing()
    .returning();
  if (!refund) throw conflict("This order has already been refunded.");
  await appendRefundEvent(
    tx,
    refund,
    "REQUESTED",
    method === "WALLET"
      ? `Refund of ${formatPaise(refund.amountPaise)} to your GoKesari wallet requested.`
      : `Refund of ${formatPaise(refund.amountPaise)} to your original payment method requested.`,
    actorId,
  );
  await recordAudit(
    {
      actorId,
      actorRole: input.actor?.role ?? null,
      action: AUDIT_ACTIONS.ORDER_REFUND_RECORDED,
      entityType: "order",
      entityId: order.id,
      newValue: { refundId: refund.id, method, amountPaise: refund.amountPaise, deductionsPaise: refund.deductionsPaise },
    },
    tx,
  );

  if (refund.amountPaise === 0) {
    const [done] = await tx
      .update(orderRefunds)
      .set({ status: "SUCCESS", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(orderRefunds.id, refund.id))
      .returning();
    await appendRefundEvent(tx, done, "SUCCESS", "Nothing to refund: the charges equal the amount paid.", actorId);
    await announceRefund(tx, done, order.orderNumber, "Nothing was refunded: the charges equal the amount paid.", input.actor);
    return "CANCELLED";
  }

  if (method === "WALLET") {
    await completeToWallet(tx, refund, order, input.actor, "Refunded to your GoKesari wallet.");
    await setOrderStatus(
      tx,
      order.id,
      "CANCELLED",
      "REFUNDED",
      actorId,
      breakdown.deductionsPaise > 0
        ? `Wallet refunded ${formatPaise(refund.amountPaise)} (${formatPaise(breakdown.deductionsPaise)} kept: ${breakdown.deductions.map((d) => d.label).join(", ")})`
        : "Wallet refunded",
    );
    return "REFUNDED";
  }

  await setOrderStatus(tx, order.id, "CANCELLED", "REFUND_PENDING", actorId, "Refund to the original payment method requested");
  await announceRefund(tx, refund, order.orderNumber, "is on its way back to your original payment method.", input.actor);
  return "REFUND_PENDING";
}

async function completeToWallet(tx: DbClient, refund: OrderRefund, order: Order, actor: Actor, note: string) {
  const result = await creditWallet(
    tx,
    refund,
    order,
    actor?.id ?? null,
    isPartRefund(refund)
      ? (refund.reason ?? `Refund for order ${order.orderNumber}`)
      : refund.deductionsPaise > 0
        ? `Refund for cancelled order ${order.orderNumber} (${formatPaise(refund.deductionsPaise)} in charges kept)`
        : `Refund for cancelled order ${order.orderNumber}`,
  );
  const [done] = await tx
    .update(orderRefunds)
    .set({
      method: "WALLET",
      status: "SUCCESS",
      walletTransactionId: result.transaction.id,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(orderRefunds.id, refund.id))
    .returning();
  await appendRefundEvent(tx, done, "SUCCESS", note, actor?.id ?? null);
  await announceRefund(tx, done, order.orderNumber, "has been added to your GoKesari wallet — it is ready to use now.", actor);
  return done;
}

/* ------------------------------------------- part of a continuing order */

export type PartRefundRoute = "WALLET" | "ORIGINAL" | "NONE";

export interface PartRefundResult {
  route: PartRefundRoute;
  /** The order_refunds row (online-paid orders only). */
  refund: OrderRefund | null;
  /** The wallet credit, when the money went to the wallet. */
  walletTransactionId: string | null;
}

/**
 * TC-PAY-029: refunds part of a paid order that carries on — a line the shop
 * removed, or the difference to a cheaper substitute — the way the order was
 * paid, exactly as a cancellation would be refunded:
 *
 *   paid from the wallet  → the original wallet debit, same split (as before);
 *   paid online           → an order_refunds row, to the original method by
 *                           default (refundMethodsFor), else the wallet. The
 *                           gateway refund is only recorded here; the caller
 *                           sends it after commit (sendRequestedOriginalRefunds)
 *                           and the aftercare / payments jobs retry it;
 *   cash on delivery, or not paid yet → nothing to give back: the amount
 *                           still to collect simply drops with the order total.
 *
 * Runs inside the caller's transaction, under the order's row lock. `key`
 * identifies the part (e.g. `line:<itemId>`): a replay refunds it once. Also
 * used for a refund after delivery (finance.ts refundDeliveredOrder, N2), whose
 * cash-on-delivery case stays a wallet credit there.
 */
export async function refundOrderPart(
  tx: DbClient,
  order: Order,
  input: { amountPaise: number; key: string; description: string; actor: Actor },
): Promise<PartRefundResult> {
  if (input.amountPaise <= 0 || order.paidAt == null) return { route: "NONE", refund: null, walletTransactionId: null };
  const payment = await paymentChannelFor(order, tx);
  const actorId = input.actor?.id ?? null;
  if (payment.channel === "COD") return { route: "NONE", refund: null, walletTransactionId: null };
  if (payment.channel === "WALLET") {
    const mutation = {
      userId: order.userId,
      idempotencyKey: `refund:order:${order.id}:${input.key}`,
      description: input.description,
      createdBy: actorId,
      amountPaise: input.amountPaise,
    };
    let credited;
    if (payment.hasWalletDebit) {
      credited = await refundOriginalDebit({ ...mutation, referenceType: "orderId", referenceId: order.id }, tx);
    } else {
      // No wallet debit and no captured gateway payment on record: a plain wallet credit.
      await getOrCreateWallet(order.userId, tx);
      credited = await applyWalletMutation({ ...mutation, type: "REFUND", orderId: order.id, promotionalAmountPaise: 0 }, tx);
    }
    return { route: "WALLET", refund: null, walletTransactionId: credited.transaction.id };
  }

  const key = partRefundKey(order.id, input.key);
  const prior = await tx.query.orderRefunds.findFirst({ where: eq(orderRefunds.idempotencyKey, key) });
  if (prior) {
    const route = prior.method === "ORIGINAL" && !prior.fellBackToWallet ? "ORIGINAL" : "WALLET";
    return { route, refund: prior, walletTransactionId: prior.walletTransactionId };
  }
  const method: RefundMethod = (await refundMethodsFor("ONLINE"))[0];
  const [held] = await tx.select({ totalPaise: orders.totalPaise }).from(orders).where(eq(orders.id, order.id));
  const [refund] = await tx
    .insert(orderRefunds)
    .values({
      orderId: order.id,
      userId: order.userId,
      method,
      paymentChannel: "ONLINE",
      status: "REQUESTED",
      paidPaise: held?.totalPaise ?? order.totalPaise,
      deductionsPaise: 0,
      amountPaise: input.amountPaise,
      breakdown: { kind: "PART", part: input.key, refundPaise: input.amountPaise },
      reason: input.description,
      gatewayIntentId: method === "ORIGINAL" ? (payment.intent?.id ?? null) : null,
      idempotencyKey: key,
      requestedBy: actorId,
    })
    .returning();
  await appendRefundEvent(
    tx,
    refund,
    "REQUESTED",
    method === "WALLET"
      ? `Refund of ${formatPaise(refund.amountPaise)} to your GoKesari wallet requested.`
      : `Refund of ${formatPaise(refund.amountPaise)} to your original payment method requested.`,
    actorId,
  );
  await recordAudit(
    {
      actorId,
      actorRole: input.actor?.role ?? null,
      action: AUDIT_ACTIONS.ORDER_REFUND_RECORDED,
      entityType: "order",
      entityId: order.id,
      newValue: { refundId: refund.id, method, amountPaise: refund.amountPaise, part: input.key },
    },
    tx,
  );
  if (method === "WALLET") {
    const done = await completeToWallet(tx, refund, order, input.actor, "Refunded to your GoKesari wallet.");
    return { route: "WALLET", refund: done, walletTransactionId: done.walletTransactionId };
  }
  await announceRefund(tx, refund, order.orderNumber, "is on its way back to your original payment method.", input.actor);
  return { route: "ORIGINAL", refund, walletTransactionId: null };
}

/**
 * Another refund of the same order still on its way to the original method
 * (a line refund and the cancellation's can be in flight together): the order
 * becomes REFUNDED only once the last one settles.
 */
async function otherRefundOpen(tx: DbClient, orderId: string, refundId: string): Promise<boolean> {
  const [open] = await tx
    .select({ id: orderRefunds.id })
    .from(orderRefunds)
    .where(
      and(
        eq(orderRefunds.orderId, orderId),
        eq(orderRefunds.method, "ORIGINAL"),
        inArray(orderRefunds.status, ["REQUESTED", "PROCESSING"]),
        ne(orderRefunds.id, refundId),
      ),
    )
    .limit(1);
  return Boolean(open);
}

/* --------------------------------------------- original payment method */

async function lockRefund(tx: DbClient, refundId: string): Promise<OrderRefund> {
  const [row] = await tx.select().from(orderRefunds).where(eq(orderRefunds.id, refundId)).for("update");
  if (!row) throw notFound("Refund");
  return row;
}

async function finishOriginal(
  refundId: string,
  outcome: { status: "PROCESSING" | "SUCCESS" | "FAILED"; ref?: string | null; error?: string | null },
): Promise<OrderRefund> {
  return db.transaction(async (tx) => {
    const refund = await lockRefund(tx, refundId);
    if (refund.status === "SUCCESS" || refund.status === "FAILED") return refund;
    if (refund.status === outcome.status) return refund;
    const order = await tx.query.orders.findFirst({ where: eq(orders.id, refund.orderId) });
    if (!order) throw notFound("Order");
    if (outcome.status === "PROCESSING") {
      const [row] = await tx
        .update(orderRefunds)
        .set({ status: "PROCESSING", gatewayRefundRef: outcome.ref ?? refund.gatewayRefundRef, updatedAt: new Date() })
        .where(eq(orderRefunds.id, refund.id))
        .returning();
      await appendRefundEvent(tx, row, "PROCESSING", "The payment gateway is processing your refund (usually 5–7 working days to reach your bank).", null);
      await announceRefund(tx, row, order.orderNumber, "is being processed by the payment gateway.", null);
      return row;
    }
    if (outcome.status === "SUCCESS") {
      const [row] = await tx
        .update(orderRefunds)
        .set({ status: "SUCCESS", gatewayRefundRef: outcome.ref ?? refund.gatewayRefundRef, completedAt: new Date(), updatedAt: new Date() })
        .where(eq(orderRefunds.id, refund.id))
        .returning();
      await appendRefundEvent(tx, row, "SUCCESS", "Refunded to your original payment method.", null);
      await announceRefund(tx, row, order.orderNumber, "has been refunded to your original payment method.", null);
      if (order.status === "REFUND_PENDING" && !(await otherRefundOpen(tx, order.id, refund.id))) {
        await setOrderStatus(tx, order.id, "REFUND_PENDING", "REFUNDED", null, "Refunded to the original payment method");
      }
      return row;
    }
    // FAILED at the gateway: told, then (rule) credited to the wallet instead.
    const [failed] = await tx
      .update(orderRefunds)
      .set({ status: "FAILED", lastError: outcome.error ?? refund.lastError, updatedAt: new Date() })
      .where(eq(orderRefunds.id, refund.id))
      .returning();
    await appendRefundEvent(tx, failed, "FAILED", "The payment gateway could not complete the refund.", null);
    await announceRefund(tx, failed, order.orderNumber, "could not be sent to your original payment method.", null);
    if ((await getRule("refundChoice")).fallbackToWallet) {
      const [retry] = await tx
        .update(orderRefunds)
        .set({ status: "REQUESTED", fellBackToWallet: true, updatedAt: new Date() })
        .where(eq(orderRefunds.id, refund.id))
        .returning();
      const done = await completeToWallet(tx, retry, order, null, "Credited to your GoKesari wallet instead, because the gateway refund failed.");
      if (order.status === "REFUND_PENDING" && !(await otherRefundOpen(tx, order.id, refund.id))) {
        await setOrderStatus(tx, order.id, "REFUND_PENDING", "REFUNDED", null, "Gateway refund failed — wallet refunded");
      }
      return done;
    }
    return failed;
  });
}

/**
 * Sends a REQUESTED refund to the original payment method. Safe to call
 * again (the gateway call is idempotent on the refund id); after
 * refundChoice.maxGatewayAttempts failed calls the refund is marked FAILED
 * (and, by rule, credited to the wallet).
 */
export async function processOriginalRefund(refundId: string): Promise<OrderRefund> {
  const refund = await db.query.orderRefunds.findFirst({ where: eq(orderRefunds.id, refundId) });
  if (!refund) throw notFound("Refund");
  if (refund.method !== "ORIGINAL" || refund.status !== "REQUESTED") return refund;
  if (!refund.gatewayIntentId) return finishOriginal(refund.id, { status: "FAILED", error: "No captured payment to refund." });
  const { maxGatewayAttempts } = await getRule("refundChoice");
  const [counted] = await db
    .update(orderRefunds)
    .set({ attempts: sql`${orderRefunds.attempts} + 1`, updatedAt: new Date() })
    .where(and(eq(orderRefunds.id, refund.id), eq(orderRefunds.status, "REQUESTED")))
    .returning();
  if (!counted) return refund;
  try {
    const result = await refundPaymentIntent({
      intentId: refund.gatewayIntentId,
      amountPaise: refund.amountPaise,
      reason: refund.reason ?? "Order cancelled",
      idempotencyKey: `order-refund:${refund.id}`,
      // Links WS-A's gateway refund to the order; both sides move REFUND_PENDING → REFUNDED
      // only from REFUND_PENDING, so whichever settles first wins and the other is a no-op.
      orderId: refund.orderId,
    });
    if (result.status === "SUCCESS") return finishOriginal(refund.id, { status: "SUCCESS", ref: result.id });
    if (result.status === "FAILED") return finishOriginal(refund.id, { status: "FAILED", ref: result.id, error: "Gateway reported the refund failed." });
    return finishOriginal(refund.id, { status: "PROCESSING", ref: result.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(orderRefunds).set({ lastError: message.slice(0, 500), updatedAt: new Date() }).where(eq(orderRefunds.id, refund.id));
    if (counted.attempts >= maxGatewayAttempts) return finishOriginal(refund.id, { status: "FAILED", error: message.slice(0, 500) });
    return (await db.query.orderRefunds.findFirst({ where: eq(orderRefunds.id, refund.id) }))!;
  }
}

/**
 * For the payment workstream's refund webhook: the gateway's final word on a
 * refund we started (`idempotencyKey` = "order-refund:<refund id>").
 */
export async function recordGatewayRefundResult(
  idempotencyKey: string,
  status: "SUCCESS" | "FAILED",
  gatewayRefundRef?: string | null,
): Promise<OrderRefund | null> {
  const id = idempotencyKey.startsWith("order-refund:") ? idempotencyKey.slice("order-refund:".length) : null;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await db.query.orderRefunds.findFirst({ where: eq(orderRefunds.id, id) });
  if (!row) return null;
  return finishOriginal(row.id, { status, ref: gatewayRefundRef ?? null, error: status === "FAILED" ? "Gateway reported the refund failed." : null });
}

/**
 * The aftercare job: retries REQUESTED gateway refunds and settles
 * PROCESSING ones from the payment intent's state (REFUNDED /
 * PARTIALLY_REFUNDED with enough refunded). Idempotent.
 */
/** Sends every still-REQUESTED original-method refund of one order (after its cancellation commits). */
export async function sendRequestedOriginalRefunds(orderId: string): Promise<number> {
  const requested = await db
    .select({ id: orderRefunds.id })
    .from(orderRefunds)
    .where(and(eq(orderRefunds.orderId, orderId), eq(orderRefunds.method, "ORIGINAL"), eq(orderRefunds.status, "REQUESTED")));
  for (const refund of requested) await processOriginalRefund(refund.id);
  return requested.length;
}

export async function runRefundSweep(): Promise<{ retried: number; completed: number }> {
  const pending = await db
    .select()
    .from(orderRefunds)
    .where(and(eq(orderRefunds.method, "ORIGINAL"), inArray(orderRefunds.status, ["REQUESTED", "PROCESSING"])))
    .orderBy(asc(orderRefunds.createdAt))
    .limit(200);
  let retried = 0;
  let completed = 0;
  for (const refund of pending) {
    try {
      if (refund.status === "REQUESTED") {
        await processOriginalRefund(refund.id);
        retried += 1;
        continue;
      }
      if (!refund.gatewayIntentId) continue;
      const intent = await getPaymentIntent(refund.gatewayIntentId);
      if (intent && (intent.status === "REFUNDED" || (intent.status === "PARTIALLY_REFUNDED" && intent.refundedPaise >= refund.amountPaise))) {
        await finishOriginal(refund.id, { status: "SUCCESS" });
        completed += 1;
      }
    } catch (error) {
      console.error("[refunds] sweep failed for", refund.id, error);
    }
  }
  return { retried, completed };
}

/* ------------------------------------------------------------ timeline */

export interface RefundTimelineEntry {
  at: Date;
  status: RefundStatus;
  note: string | null;
}

export interface RefundView {
  id: string | null;
  method: RefundMethod;
  status: RefundStatus;
  amountPaise: number;
  paidPaise: number;
  deductionsPaise: number;
  deductions: BreakdownLine[];
  fellBackToWallet: boolean;
  createdAt: Date;
  timeline: RefundTimelineEntry[];
}

/**
 * The refunds on an order, newest first, each with its timeline. Refunds
 * made before this feature (or by the shop / operations through the original
 * path) are shown from the wallet ledger as completed wallet refunds.
 */
export async function listRefundsForOrder(orderId: string): Promise<RefundView[]> {
  const rows = await db.select().from(orderRefunds).where(eq(orderRefunds.orderId, orderId)).orderBy(desc(orderRefunds.createdAt));
  const events = rows.length
    ? await db
        .select()
        .from(orderRefundEvents)
        .where(inArray(orderRefundEvents.refundId, rows.map((r) => r.id)))
        .orderBy(asc(orderRefundEvents.createdAt))
    : [];
  const views: RefundView[] = rows.map((r) => ({
    id: r.id,
    method: r.method,
    status: r.status,
    amountPaise: r.amountPaise,
    paidPaise: r.paidPaise,
    deductionsPaise: r.deductionsPaise,
    deductions: ((r.breakdown as { deductions?: BreakdownLine[] }).deductions ?? []) as BreakdownLine[],
    fellBackToWallet: r.fellBackToWallet,
    createdAt: r.createdAt,
    timeline: events.filter((e) => e.refundId === r.id).map((e) => ({ at: e.createdAt, status: e.status, note: e.note })),
  }));
  const tracked = new Set(rows.map((r) => r.walletTransactionId).filter(Boolean));
  const ledger = await db
    .select()
    .from(walletTransactions)
    .where(and(eq(walletTransactions.orderId, orderId), eq(walletTransactions.type, "REFUND")))
    .orderBy(desc(walletTransactions.createdAt));
  for (const t of ledger) {
    if (tracked.has(t.id)) continue;
    views.push({
      id: null,
      method: "WALLET",
      status: "SUCCESS",
      amountPaise: t.amountPaise,
      paidPaise: t.amountPaise,
      deductionsPaise: 0,
      deductions: [],
      fellBackToWallet: false,
      createdAt: t.createdAt,
      timeline: [{ at: t.createdAt, status: "SUCCESS", note: t.description }],
    });
  }
  return views.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export async function findRefundForCancellation(orderId: string): Promise<OrderRefund | null> {
  return (await db.query.orderRefunds.findFirst({ where: eq(orderRefunds.idempotencyKey, `order-refund:cancel:${orderId}`) })) ?? null;
}
