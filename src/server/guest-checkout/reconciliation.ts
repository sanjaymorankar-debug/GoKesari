/**
 * docs/guest-checkout-2026-11: read-only reconciliation of multi-shop purchases for finance —
 * one online payment (payment intent, purpose ORDER_GROUP) against the shop orders it paid for:
 *
 *   paid (captured intent)  vs  Σ child amounts charged at checkout (total now + part refunds
 *                               already taken off it: removed / cheaper substituted lines)
 *   refunded on the intent  vs  Σ gateway refunds per child (payment_refunds.order_id)
 *   per child: order refunds (wallet / original method), settlement status of its shop payout
 *
 * Nothing is changed here; differences are shown for a person to look into.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/server/db";
import {
  orderFinancials,
  orderGroups,
  orderRefunds,
  orders,
  paymentIntents,
  paymentRefunds,
  shops,
  shopSettlements,
  users,
} from "@/server/db/schema";

const PAID_INTENT = new Set(["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"]);

export interface ReconChildInput {
  orderId: string;
  totalPaise: number;
  /** orders.refunded_paise: part refunds that already lowered totalPaise. */
  partRefundedPaise: number;
  /** Successful gateway refunds against the group payment for this order. */
  gatewayRefundedPaise: number;
  /** Successful order refunds of any method (wallet or original), for display. */
  orderRefundedPaise: number;
}

export interface ReconIntentInput {
  id: string;
  status: string;
  amountPaise: number;
  refundedPaise: number;
}

export type ReconStatus = "MATCHED" | "AMOUNT_MISMATCH" | "REFUND_MISMATCH" | "NO_PAYMENT" | "DUPLICATE_PAYMENT" | "NOT_ONLINE";

export interface ReconResult {
  status: ReconStatus;
  paidPaise: number;
  /** Σ (child total + part refunds) — what the shops' orders came to at checkout. */
  childrenTotalPaise: number;
  /** paid − childrenTotalPaise; 0 when they agree. */
  differencePaise: number;
  intentRefundedPaise: number;
  childGatewayRefundsPaise: number;
  /** intent's refunded − Σ child gateway refunds; 0 when they agree. */
  refundDifferencePaise: number;
  childOrderRefundsPaise: number;
}

/** The reconciliation sums and verdict for one group. Pure. */
export function reconcileGroup(input: { online: boolean; intents: ReconIntentInput[]; children: ReconChildInput[] }): ReconResult {
  const paid = input.intents.filter((i) => PAID_INTENT.has(i.status));
  const childrenTotalPaise = input.children.reduce((n, c) => n + c.totalPaise + c.partRefundedPaise, 0);
  const childGatewayRefundsPaise = input.children.reduce((n, c) => n + c.gatewayRefundedPaise, 0);
  const childOrderRefundsPaise = input.children.reduce((n, c) => n + c.orderRefundedPaise, 0);
  const paidPaise = paid.reduce((n, i) => n + i.amountPaise, 0);
  const intentRefundedPaise = paid.reduce((n, i) => n + i.refundedPaise, 0);
  const differencePaise = paidPaise - childrenTotalPaise;
  const refundDifferencePaise = intentRefundedPaise - childGatewayRefundsPaise;
  let status: ReconStatus;
  if (!input.online) status = "NOT_ONLINE";
  else if (paid.length === 0) status = "NO_PAYMENT";
  else if (paid.length > 1) status = "DUPLICATE_PAYMENT";
  else if (differencePaise !== 0) status = "AMOUNT_MISMATCH";
  else if (refundDifferencePaise !== 0) status = "REFUND_MISMATCH";
  else status = "MATCHED";
  return {
    status,
    paidPaise,
    childrenTotalPaise,
    differencePaise,
    intentRefundedPaise,
    childGatewayRefundsPaise,
    refundDifferencePaise,
    childOrderRefundsPaise,
  };
}

export interface ReconChildRow {
  orderId: string;
  orderNumber: string;
  shopName: string;
  status: string;
  paymentMethod: string;
  totalPaise: number;
  partRefundedPaise: number;
  gatewayRefundedPaise: number;
  orderRefundedPaise: number;
  settlement: { id: string; status: string; paidAt: Date | null } | null;
}

export interface ReconGroupRow {
  groupId: string;
  reference: string;
  createdAt: Date;
  customerEmail: string | null;
  intents: (ReconIntentInput & { gateway: string; capturedAt: Date | null })[];
  children: ReconChildRow[];
  result: ReconResult;
}

/** The latest order groups (or the one with `reference`) with their reconciliation. */
export async function listGroupReconciliation(options: { reference?: string | null; limit?: number } = {}): Promise<ReconGroupRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const ref = options.reference?.trim().toUpperCase();
  const groups = await db
    .select({ id: orderGroups.id, reference: orderGroups.reference, createdAt: orderGroups.createdAt, email: users.email })
    .from(orderGroups)
    .leftJoin(users, eq(users.id, orderGroups.userId))
    .where(ref ? eq(orderGroups.reference, ref) : undefined)
    .orderBy(desc(orderGroups.createdAt))
    .limit(limit);
  if (groups.length === 0) return [];
  const groupIds = groups.map((g) => g.id);

  const [childRows, intentRows] = await Promise.all([
    db
      .select({
        orderId: orders.id,
        groupId: orders.orderGroupId,
        orderNumber: orders.orderNumber,
        shopName: shops.name,
        status: orders.status,
        paymentMethod: orders.paymentMethod,
        totalPaise: orders.totalPaise,
        partRefundedPaise: orders.refundedPaise,
        settlementId: orderFinancials.settlementId,
        settlementStatus: shopSettlements.status,
        settlementPaidAt: shopSettlements.paidAt,
      })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .leftJoin(orderFinancials, eq(orderFinancials.orderId, orders.id))
      .leftJoin(shopSettlements, eq(shopSettlements.id, orderFinancials.settlementId))
      .where(inArray(orders.orderGroupId, groupIds)),
    db
      .select({
        id: paymentIntents.id,
        referenceId: paymentIntents.referenceId,
        status: paymentIntents.status,
        amountPaise: paymentIntents.amountPaise,
        refundedPaise: paymentIntents.refundedPaise,
        gateway: paymentIntents.gateway,
        capturedAt: paymentIntents.capturedAt,
      })
      .from(paymentIntents)
      .where(and(eq(paymentIntents.purpose, "ORDER_GROUP"), inArray(paymentIntents.referenceId, groupIds))),
  ]);
  const orderIds = childRows.map((c) => c.orderId);
  const intentIds = intentRows.map((i) => i.id);
  const [gatewayRefunds, ordRefunds] = await Promise.all([
    intentIds.length === 0
      ? []
      : db
          .select({ orderId: paymentRefunds.orderId, amountPaise: paymentRefunds.amountPaise })
          .from(paymentRefunds)
          .where(and(inArray(paymentRefunds.intentId, intentIds), eq(paymentRefunds.status, "SUCCESS"))),
    orderIds.length === 0
      ? []
      : db
          .select({ orderId: orderRefunds.orderId, amountPaise: orderRefunds.amountPaise })
          .from(orderRefunds)
          .where(and(inArray(orderRefunds.orderId, orderIds), eq(orderRefunds.status, "SUCCESS"))),
  ]);
  const sumBy = (rows: { orderId: string | null; amountPaise: number }[], id: string) =>
    rows.filter((r) => r.orderId === id).reduce((n, r) => n + Number(r.amountPaise), 0);

  return groups.map((g) => {
    const children: ReconChildRow[] = childRows
      .filter((c) => c.groupId === g.id)
      .map((c) => ({
        orderId: c.orderId,
        orderNumber: c.orderNumber,
        shopName: c.shopName,
        status: c.status,
        paymentMethod: c.paymentMethod,
        totalPaise: c.totalPaise,
        partRefundedPaise: Number(c.partRefundedPaise),
        gatewayRefundedPaise: sumBy(gatewayRefunds, c.orderId),
        orderRefundedPaise: sumBy(ordRefunds, c.orderId),
        settlement: c.settlementId ? { id: c.settlementId, status: c.settlementStatus ?? "PENDING", paidAt: c.settlementPaidAt ?? null } : null,
      }));
    const intents = intentRows
      .filter((i) => i.referenceId === g.id)
      .map((i) => ({ id: i.id, status: i.status, amountPaise: Number(i.amountPaise), refundedPaise: Number(i.refundedPaise), gateway: i.gateway, capturedAt: i.capturedAt }));
    const online = children.some((c) => c.paymentMethod === "ONLINE") || intents.length > 0;
    return {
      groupId: g.id,
      reference: g.reference,
      createdAt: g.createdAt,
      customerEmail: g.email,
      intents,
      children,
      result: reconcileGroup({ online, intents, children }),
    };
  });
}
