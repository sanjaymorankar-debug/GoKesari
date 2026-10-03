/**
 * Cash on delivery (GS-030).
 *
 *   checkout (COD) → order CONFIRMED, unpaid — no wallet debit
 *   → delivered: the collector (the rider, or the shop when it delivers
 *     itself) confirms the cash → order paid; a COD_CASH_COLLECTED
 *     adjustment (−total) is recorded against the collector
 *   → the collector hands the cash to the platform (COD_CASH_DEPOSITED, +)
 *     or it is netted in their next weekly payout / settlement.
 *
 * Nothing new moves money: the existing adjustment → batch machinery nets
 * the cash, and the finance journal records both steps (COD_CASH).
 *
 * Risk limits (decision pending confirmation — defaults below):
 *  - the shop must opt in (shops.cod_enabled) and deliver the order;
 *  - personal orders to a delivery address only;
 *  - at most ₹2,000 per order and 2 unpaid COD orders open per customer;
 *  - refused after 2 failed / returned COD deliveries in 90 days, or while
 *    the customer has an open HIGH risk flag (GS-068).
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { db, type DbClient } from "@/server/db";
import {
  deliveryOrders,
  deliveryPartners,
  financialAdjustments,
  orders,
  riskFlags,
  shops,
  type Order,
  type OrderStatus,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { postLedger } from "./finance";
import { insertIfNewReturning, insertReturning } from "@/server/db/returning";

export const COD_LIMITS = {
  maxOrderPaise: 200_000,
  maxOpenOrders: 2,
  failureWindowDays: 90,
  maxFailures: 2,
} as const;

/** COD order still waiting for its cash. */
const OPEN_COD_EXCLUDED: OrderStatus[] = [
  "DELIVERED",
  "DISPUTED",
  "CANCELLED",
  "REFUND_PENDING",
  "REFUNDED",
  "RETURNED",
];

interface Actor {
  id: string;
  role: UserRole;
}

export interface CodEligibility {
  allowed: boolean;
  reason: string | null;
  maxOrderPaise: number;
  openOrders: number;
}

/** Customer-level COD check (shop and amount are checked per order at checkout). */
export async function getCodEligibility(
  userId: string,
  client: DbClient = db,
): Promise<CodEligibility> {
  const [open] = await client
    .select({ n: sql<number>`CAST(count(*) AS SIGNED)` })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.paymentMethod, "COD"),
        notInArray(orders.status, OPEN_COD_EXCLUDED),
      ),
    );
  const [failures] = await client
    .select({ n: sql<number>`CAST(count(*) AS SIGNED)` })
    .from(orders)
    .where(
      and(
        eq(orders.userId, userId),
        eq(orders.paymentMethod, "COD"),
        sql`exists (select 1 from order_status_history h where h.order_id = ${orders.id}
              and h.new_status in ('FAILED', 'RETURNED')
              and h.created_at > now() - interval ${COD_LIMITS.failureWindowDays} day)`,
      ),
    );
  const [flag] = await client
    .select({ id: riskFlags.id })
    .from(riskFlags)
    .where(
      and(
        eq(riskFlags.subjectType, "USER"),
        eq(riskFlags.subjectId, userId),
        eq(riskFlags.status, "OPEN"),
        eq(riskFlags.severity, "HIGH"),
      ),
    )
    .limit(1);

  const base = { maxOrderPaise: COD_LIMITS.maxOrderPaise, openOrders: open.n };
  if (flag)
    return {
      ...base,
      allowed: false,
      reason: "Cash on delivery is not available on this account right now.",
    };
  if (failures.n >= COD_LIMITS.maxFailures) {
    return {
      ...base,
      allowed: false,
      reason:
        "Cash on delivery is paused after recent undelivered cash orders. Please pay from your wallet.",
    };
  }
  if (open.n >= COD_LIMITS.maxOpenOrders) {
    return {
      ...base,
      allowed: false,
      reason: `You already have ${open.n} cash-on-delivery orders on the way — pay from your wallet or wait for them to arrive.`,
    };
  }
  return { ...base, allowed: true, reason: null };
}

/** Shop- and amount-level COD check for one order at checkout. */
export function assertCodAllowedForOrder(
  shop: Pick<Shop, "name" | "codEnabled" | "deliveryAvailable">,
  totalPaise: number,
): void {
  if (!shop.codEnabled)
    throw validationFailed(`${shop.name} does not accept cash on delivery.`);
  if (!shop.deliveryAvailable)
    throw validationFailed(
      `${shop.name} does not deliver, so cash on delivery is not available.`,
    );
  if (totalPaise > COD_LIMITS.maxOrderPaise) {
    throw validationFailed(
      `Cash on delivery is available up to ${formatPaise(COD_LIMITS.maxOrderPaise)} per order — ${shop.name}'s order is ${formatPaise(totalPaise)}.`,
    );
  }
}

/**
 * Records the cash for a COD order the moment it is delivered. Called from
 * updateOrderStatus(→ DELIVERED) before the finance snapshot, inside the same
 * transaction. The collector is the rider when a platform delivery was
 * completed, otherwise the shop. Idempotent.
 */
export async function recordCodCollection(
  order: Order,
  actorId: string,
  client: DbClient,
): Promise<void> {
  if (order.paymentMethod !== "COD" || order.codCollectedAt) return;

  const [delivery] = await client
    .select({
      id: deliveryOrders.id,
      partnerId: deliveryOrders.deliveryPartnerId,
    })
    .from(deliveryOrders)
    .where(
      and(
        eq(deliveryOrders.orderId, order.id),
        eq(deliveryOrders.status, "DELIVERED"),
      ),
    )
    .limit(1);
  const party = delivery ? ("RIDER" as const) : ("SHOP" as const);
  const now = new Date();

  await client
    .update(orders)
    .set({ paidAt: order.paidAt ?? now, codCollectedAt: now, updatedAt: now })
    .where(eq(orders.id, order.id));

  const [adjustment] = await insertIfNewReturning(
    client,
    financialAdjustments,
    {
      type: "COD_CASH_COLLECTED",
      party,
      status: "PENDING",
      // Only the collector is recorded, so a rider's cash never shows in the shop's statement.
      shopId: party === "SHOP" ? order.shopId : null,
      deliveryPartnerId: delivery?.partnerId ?? null,
      orderId: order.id,
      amountPaise: -order.totalPaise,
      reason: `Cash collected for order ${order.orderNumber}`,
      idempotencyKey: `cod:collected:${order.id}`,
      createdBy: actorId,
    },
    eq(financialAdjustments.idempotencyKey, `cod:collected:${order.id}`),
  );
  if (!adjustment) return;

  const entityId = party === "RIDER" ? delivery!.partnerId : order.shopId;
  const base = {
    orderId: order.id,
    sourceType: "financial_adjustments",
    sourceId: adjustment.id,
    entryType: "COD_CASH" as const,
  };
  await postLedger(
    [
      // The collector now holds the platform's cash...
      {
        ...base,
        entityType: party,
        entityId,
        direction: "DEBIT",
        amountPaise: order.totalPaise,
        key: `cod:${order.id}:collector`,
      },
      // ...which the platform has been paid.
      {
        ...base,
        entityType: "PLATFORM",
        direction: "CREDIT",
        amountPaise: order.totalPaise,
        key: `cod:${order.id}:platform`,
      },
    ],
    actorId,
    client,
  );

  await recordAudit(
    {
      actorId,
      action: AUDIT_ACTIONS.COD_CASH_COLLECTED,
      entityType: "order",
      entityId: order.id,
      newValue: {
        amountPaise: order.totalPaise,
        collector: party,
        collectorId: entityId,
      },
    },
    client,
  );
}

export interface CashHolder {
  party: "RIDER" | "SHOP";
  id: string;
  name: string;
  heldPaise: number;
  orders: number;
}

/** Cash collected but not yet deposited or netted in a batch, per collector. */
export async function listCodCashHeld(): Promise<CashHolder[]> {
  const rows = await db
    .select({
      party: financialAdjustments.party,
      partnerId: financialAdjustments.deliveryPartnerId,
      shopId: financialAdjustments.shopId,
      riderName: deliveryPartners.fullName,
      shopName: shops.name,
      net: sql<number>`CAST(sum(${financialAdjustments.amountPaise}) AS SIGNED)`,
      orders: sql<number>`CAST(count(case when ${financialAdjustments.type} = 'COD_CASH_COLLECTED' then 1 end) AS SIGNED)`,
    })
    .from(financialAdjustments)
    .leftJoin(
      deliveryPartners,
      eq(financialAdjustments.deliveryPartnerId, deliveryPartners.id),
    )
    .leftJoin(shops, eq(financialAdjustments.shopId, shops.id))
    .where(
      and(
        inArray(financialAdjustments.type, [
          "COD_CASH_COLLECTED",
          "COD_CASH_DEPOSITED",
        ]),
        eq(financialAdjustments.status, "PENDING"),
      ),
    )
    .groupBy(
      financialAdjustments.party,
      financialAdjustments.deliveryPartnerId,
      financialAdjustments.shopId,
      deliveryPartners.fullName,
      shops.name,
    );

  // Rider rows carry the order's shop id too; fold to one row per collector.
  const byKey = new Map<string, CashHolder>();
  for (const r of rows) {
    const party = r.party === "RIDER" ? "RIDER" : "SHOP";
    const id = party === "RIDER" ? r.partnerId! : r.shopId!;
    const key = `${party}:${id}`;
    const entry = byKey.get(key) ?? {
      party,
      id,
      name: (party === "RIDER" ? r.riderName : r.shopName) ?? "—",
      heldPaise: 0,
      orders: 0,
    };
    entry.heldPaise += -Number(r.net);
    entry.orders += r.orders;
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .filter((h) => h.heldPaise > 0)
    .sort((a, b) => b.heldPaise - a.heldPaise);
}

export interface CodDepositInput {
  party: "RIDER" | "SHOP";
  /** Delivery partner id or shop id. */
  id: string;
  amountPaise: number;
  reference: string;
  /** Client id so a double submit records one deposit. */
  requestId: string;
}

/**
 * Operations records cash handed over by a rider or shop. Limited to cash
 * still held (collected and not yet netted in a batch); the deposit cancels
 * that much of the collection in the next batch.
 */
export async function recordCodDeposit(input: CodDepositInput, actor: Actor) {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw validationFailed("Deposit amount must be more than zero.");
  }
  const reference = input.reference.trim();
  if (reference.length < 3)
    throw validationFailed("Enter the receipt / deposit reference.");

  const holder = (await listCodCashHeld()).find(
    (h) => h.party === input.party && h.id === input.id,
  );
  if (!holder) throw notFound("Cash to deposit");
  if (input.amountPaise > holder.heldPaise) {
    throw conflict(
      `${holder.name} holds ${formatPaise(holder.heldPaise)} — the deposit cannot be larger.`,
    );
  }

  const key = `cod:deposit:${input.party}:${input.id}:${input.requestId}`;
  return db.transaction(async (tx) => {
    const existing = await tx.query.financialAdjustments.findFirst({
      where: eq(financialAdjustments.idempotencyKey, key),
    });
    if (existing) return existing;

    const [row] = await insertReturning(tx, financialAdjustments, {
      type: "COD_CASH_DEPOSITED",
      party: input.party,
      status: "PENDING",
      shopId: input.party === "SHOP" ? input.id : null,
      deliveryPartnerId: input.party === "RIDER" ? input.id : null,
      amountPaise: input.amountPaise,
      reason: `Cash deposited — ref ${reference}`,
      idempotencyKey: key,
      createdBy: actor.id,
    });

    const base = {
      orderId: null,
      sourceType: "financial_adjustments",
      sourceId: row.id,
      entryType: "COD_CASH" as const,
      reference,
    };
    await postLedger(
      [
        {
          ...base,
          entityType: input.party,
          entityId: input.id,
          direction: "CREDIT",
          amountPaise: input.amountPaise,
          key: `cod-deposit:${row.id}:collector`,
        },
        {
          ...base,
          entityType: "PLATFORM",
          direction: "DEBIT",
          amountPaise: input.amountPaise,
          key: `cod-deposit:${row.id}:platform`,
        },
      ],
      actor.id,
      tx,
    );
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.COD_CASH_DEPOSITED,
        entityType: "financial_adjustment",
        entityId: row.id,
        newValue: {
          party: input.party,
          id: input.id,
          amountPaise: input.amountPaise,
          reference,
        },
      },
      tx,
    );
    return row;
  });
}
