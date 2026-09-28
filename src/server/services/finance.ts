/**
 * Marketplace finance (Vertical Slice 6 — GS-061/062/063/064/031, WF-010).
 *
 *   order paid (wallet ledger debit = the payment record)
 *   → DELIVERED → order_financials snapshot (GMV, discount, commission, shop payable)
 *   → rider earning (delivery_partner_earnings, existing)
 *   → refunds / adjustments (financial_adjustments)
 *   → weekly shop settlement & rider payout
 *        PENDING → ELIGIBLE → PROCESSING → PAID | FAILED → (retry) ; PAID → REVERSED
 *   → finance_ledger_entries journal for every step
 *   → reconciliation_records
 *
 * Decisions (D6, 2026-09-24): commission % by shop type with per-shop
 * override; delivery fee is platform revenue and rider earnings a platform
 * cost; weekly batches. Nothing here moves money: PROCESSING/PAID record
 * what an admin did at the bank.
 */
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { addDays, assertIsoDate, isoWeekday, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import type { ShopTypeKey } from "@/lib/shop-types";
import { db, type DbClient } from "@/server/db";
import {
  commissionRates,
  deliveryOrders,
  deliveryPartnerEarnings,
  deliveryPartners,
  financeLedgerEntries,
  financialAdjustments,
  orderFinancials,
  orders,
  payments,
  reconciliationRecords,
  riderPayouts,
  shopSettlements,
  shops,
  walletTransactions,
  type AdjustmentType,
  type CommissionRate,
  type CommissionScope,
  type DeliveryPartnerEarning,
  type FinancialAdjustment,
  type FinancialParty,
  type LedgerEntryType,
  type PayoutStatus,
  type ReconciliationEntity,
  type ReconciliationStatus,
  type RiderPayout,
  type Shop,
  type ShopSettlement,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { refundOriginalDebit } from "./wallet";

interface Actor {
  id: string;
  role: UserRole;
}

/** Batch preparation and reconciliation can also run from cron (no user). */
interface SystemOrActor {
  id: string | null;
  role: UserRole | null;
}

/** Days after delivery before an order can be settled — room for complaints and refunds. */
export const SETTLEMENT_HOLD_DAYS = 2;

/* ============================================================ ledger */

interface LedgerLine {
  orderId?: string | null;
  entityType: FinancialParty;
  entityId?: string | null;
  entryType: LedgerEntryType;
  direction: "CREDIT" | "DEBIT";
  amountPaise: number;
  sourceType: string;
  sourceId: string;
  reference?: string | null;
  /** Unique per line; re-posting the same event is a no-op. */
  key: string;
}

/** Append entries to the marketplace journal (Part I). Zero amounts are skipped. */
export async function postLedger(lines: LedgerLine[], createdBy: string | null, client: DbClient = db): Promise<void> {
  const rows = lines
    .filter((l) => l.amountPaise !== 0)
    .map((l) => ({
      orderId: l.orderId ?? null,
      entityType: l.entityType,
      entityId: l.entityId ?? null,
      entryType: l.entryType,
      // A negative amount flips the direction so stored amounts stay positive.
      direction: l.amountPaise > 0 ? l.direction : l.direction === "CREDIT" ? ("DEBIT" as const) : ("CREDIT" as const),
      amountPaise: Math.abs(l.amountPaise),
      sourceType: l.sourceType,
      sourceId: l.sourceId,
      reference: l.reference ?? null,
      idempotencyKey: l.key,
      createdBy,
    }));
  if (rows.length === 0) return;
  await client.insert(financeLedgerEntries).values(rows).onConflictDoNothing();
}

export async function listLedgerEntries(options: { orderId?: string; entityType?: FinancialParty; entityId?: string; limit?: number } = {}) {
  const conditions = [
    options.orderId ? eq(financeLedgerEntries.orderId, options.orderId) : undefined,
    options.entityType ? eq(financeLedgerEntries.entityType, options.entityType) : undefined,
    options.entityId ? eq(financeLedgerEntries.entityId, options.entityId) : undefined,
  ].filter(Boolean);
  return db
    .select()
    .from(financeLedgerEntries)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(financeLedgerEntries.createdAt))
    .limit(Math.min(options.limit ?? 200, 1000));
}

/* ======================================================== commission */

export interface ResolvedCommission {
  rateBp: number;
  rateId: string | null;
  scope: CommissionScope | "NONE";
}

/** Shop override → shop-type rate → platform default → 0% when nothing is configured. */
export async function resolveCommissionRate(
  shop: Pick<Shop, "id" | "shopType">,
  client: DbClient = db,
): Promise<ResolvedCommission> {
  const active = await client
    .select()
    .from(commissionRates)
    .where(eq(commissionRates.isActive, true))
    .orderBy(desc(commissionRates.createdAt));
  const pick =
    active.find((r) => r.scope === "SHOP" && r.shopId === shop.id) ??
    active.find((r) => r.scope === "SHOP_TYPE" && r.shopType === shop.shopType) ??
    active.find((r) => r.scope === "DEFAULT");
  return pick ? { rateBp: pick.rateBp, rateId: pick.id, scope: pick.scope } : { rateBp: 0, rateId: null, scope: "NONE" };
}

export function commissionOn(goodsPaise: number, rateBp: number): number {
  return Math.round((goodsPaise * rateBp) / 10_000);
}

/**
 * Sets the rate for one target, deactivating the previous one (history is
 * kept). Delivered orders keep the rate snapshotted on their order_financials.
 */
export async function setCommissionRate(
  input: { scope: CommissionScope; shopType?: ShopTypeKey | null; shopId?: string | null; rateBp: number; note?: string | null },
  actor: Actor,
): Promise<CommissionRate> {
  if (!Number.isInteger(input.rateBp) || input.rateBp < 0 || input.rateBp > 5000) {
    throw validationFailed("Commission must be between 0% and 50% (0–5000 basis points).");
  }
  const shopType = input.scope === "SHOP_TYPE" ? input.shopType ?? null : null;
  const shopId = input.scope === "SHOP" ? input.shopId ?? null : null;
  if (input.scope === "SHOP_TYPE" && !shopType) throw validationFailed("Choose the shop type.");
  if (input.scope === "SHOP" && !shopId) throw validationFailed("Choose the shop.");

  return db.transaction(async (tx) => {
    const target =
      input.scope === "DEFAULT"
        ? eq(commissionRates.scope, "DEFAULT")
        : input.scope === "SHOP_TYPE"
          ? and(eq(commissionRates.scope, "SHOP_TYPE"), eq(commissionRates.shopType, shopType!))
          : and(eq(commissionRates.scope, "SHOP"), eq(commissionRates.shopId, shopId!));
    const previous = await tx
      .update(commissionRates)
      .set({ isActive: false })
      .where(and(target, eq(commissionRates.isActive, true)))
      .returning();
    const [created] = await tx
      .insert(commissionRates)
      .values({ scope: input.scope, shopType, shopId, rateBp: input.rateBp, note: input.note ?? null, createdBy: actor.id })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.COMMISSION_RATE_SET,
        entityType: "commission_rate",
        entityId: created.id,
        previousValue: previous.map((p) => ({ id: p.id, rateBp: p.rateBp })),
        newValue: { scope: input.scope, shopType, shopId, rateBp: input.rateBp },
      },
      tx,
    );
    return created;
  });
}

export async function listCommissionRates(): Promise<(CommissionRate & { shopName: string | null })[]> {
  const rows = await db
    .select({ rate: commissionRates, shopName: shops.name })
    .from(commissionRates)
    .leftJoin(shops, eq(commissionRates.shopId, shops.id))
    .where(eq(commissionRates.isActive, true))
    .orderBy(commissionRates.scope, commissionRates.shopType);
  return rows.map((r) => ({ ...r.rate, shopName: r.shopName }));
}

/* ================================================== order financials */

/**
 * Snapshot a DELIVERED order's economics and journal it. Called inside the
 * DELIVERED transition (orders.ts). Idempotent — a second DELIVERED (a
 * dispute resolved in the shop's favour) keeps the first snapshot.
 */
export async function recordOrderFinancials(orderId: string, client: DbClient = db): Promise<void> {
  const [order] = await client.select().from(orders).where(eq(orders.id, orderId));
  if (!order || order.paidAt == null) return;
  const [shop] = await client.select().from(shops).where(eq(shops.id, order.shopId));
  if (!shop) return;

  // Part A: the wallet debit that paid for this order (checkout or subscription).
  const [debit] = await client
    .select()
    .from(walletTransactions)
    .where(and(eq(walletTransactions.orderId, orderId), sql`${walletTransactions.amountPaise} < 0`))
    .orderBy(walletTransactions.createdAt)
    .limit(1);

  const rate = await resolveCommissionRate(shop, client);
  const goodsPaise = order.subtotalPaise;
  const commissionPaise = commissionOn(goodsPaise, rate.rateBp);
  const discountPaise = debit ? Math.min(-debit.promotionalAmountPaise, goodsPaise + order.deliveryFeePaise) : 0;

  const [snapshot] = await client
    .insert(orderFinancials)
    .values({
      orderId,
      shopId: order.shopId,
      customerId: order.userId,
      paymentTransactionId: debit?.id ?? null,
      goodsPaise,
      discountPaise,
      deliveryFeePaise: order.deliveryFeePaise,
      gmvPaise: goodsPaise + order.deliveryFeePaise,
      commissionRateBp: rate.rateBp,
      commissionRateId: rate.rateId,
      commissionPaise,
      shopPayablePaise: goodsPaise - commissionPaise,
      deliveredAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (!snapshot) return;

  const base = { orderId, sourceType: "order_financials", sourceId: orderId, reference: debit?.id ?? null };
  await postLedger(
    [
      { ...base, entityType: "SHOP", entityId: order.shopId, entryType: "GOODS_SALE", direction: "CREDIT", amountPaise: goodsPaise, key: `order:${orderId}:goods` },
      { ...base, entityType: "SHOP", entityId: order.shopId, entryType: "COMMISSION", direction: "DEBIT", amountPaise: commissionPaise, key: `order:${orderId}:commission:shop` },
      { ...base, entityType: "PLATFORM", entryType: "COMMISSION", direction: "CREDIT", amountPaise: commissionPaise, key: `order:${orderId}:commission:platform` },
      { ...base, entityType: "PLATFORM", entryType: "DELIVERY_FEE", direction: "CREDIT", amountPaise: order.deliveryFeePaise, key: `order:${orderId}:delivery-fee` },
      // Promotional wallet credit spent on the order is a platform-funded discount.
      { ...base, entityType: "PLATFORM", entryType: "PROMOTIONAL_DISCOUNT", direction: "DEBIT", amountPaise: discountPaise, key: `order:${orderId}:discount` },
    ],
    null,
    client,
  );
}

/** Journal a rider earning (called where the earning is created — delivery-earnings.ts). */
export async function postRiderEarning(earning: DeliveryPartnerEarning, orderId: string | null, client: DbClient = db): Promise<void> {
  const base = { orderId, sourceType: "delivery_partner_earnings", sourceId: earning.id, entryType: "RIDER_EARNING" as const };
  await postLedger(
    [
      { ...base, entityType: "RIDER", entityId: earning.deliveryPartnerId, direction: "CREDIT", amountPaise: earning.totalPaise, key: `earning:${earning.id}:rider` },
      { ...base, entityType: "PLATFORM", direction: "DEBIT", amountPaise: earning.totalPaise, key: `earning:${earning.id}:platform` },
    ],
    null,
    client,
  );
}

/* ================================================ refunds & adjustments */

export interface RefundDeliveredInput {
  orderNumber: string;
  amountPaise: number;
  reason: string;
  /** SHOP: the shop's share comes off its next settlement. PLATFORM: platform absorbs it. */
  chargeTo: "SHOP" | "PLATFORM";
  /** Client-generated id so a double submit cannot refund twice. */
  requestId: string;
}

/**
 * Refund (full, partial or item-level amount) of a DELIVERED or DISPUTED
 * order to the customer's wallet. A full refund moves the order to REFUNDED.
 * The shop bears only its share (refunded goods − commission on them), never
 * the delivery fee. Orders delivered before the finance ledger have no
 * snapshot, so their refunds are platform-borne.
 */
export async function refundDeliveredOrder(input: RefundDeliveredInput, actor: Actor): Promise<FinancialAdjustment> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationFailed("Give a reason for the refund.");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw validationFailed("Refund amount must be more than zero.");
  }

  const result = await db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.orderNumber, input.orderNumber.trim()))
      .for("update");
    if (!order) throw notFound("Order");

    const key = `refund:order:${order.id}:after-delivery:${input.requestId}`;
    const existing = await tx.query.financialAdjustments.findFirst({ where: eq(financialAdjustments.idempotencyKey, key) });
    if (existing) return { order, adjustment: existing, fullyRefunded: false };

    if (order.status !== "DELIVERED" && order.status !== "DISPUTED") {
      throw conflict("Only a delivered or disputed order can be refunded here — cancel it instead.");
    }
    if (input.amountPaise > order.totalPaise) {
      throw validationFailed(`At most ₹${(order.totalPaise / 100).toFixed(2)} can still be refunded on this order.`);
    }

    const refund = await refundOriginalDebit(
      {
        userId: order.userId,
        referenceType: "orderId",
        referenceId: order.id,
        idempotencyKey: key,
        description: `Refund for order ${order.orderNumber}: ${reason}`,
        createdBy: actor.id,
        amountPaise: input.amountPaise,
      },
      tx,
    );

    const snapshot = await tx.query.orderFinancials.findFirst({ where: eq(orderFinancials.orderId, order.id) });
    const chargeShop = input.chargeTo === "SHOP" && snapshot != null;
    const refundedGoods = chargeShop ? Math.min(input.amountPaise, order.subtotalPaise) : 0;
    const shopShare = refundedGoods - commissionOn(refundedGoods, snapshot?.commissionRateBp ?? 0);
    const type: AdjustmentType = chargeShop ? "REFUND_SHOP" : "REFUND_PLATFORM";

    const [adjustment] = await tx
      .insert(financialAdjustments)
      .values({
        type,
        party: chargeShop ? "SHOP" : "PLATFORM",
        status: chargeShop ? "PENDING" : "RECORDED",
        shopId: order.shopId,
        orderId: order.id,
        walletTransactionId: refund.transaction.id,
        amountPaise: -shopShare,
        customerRefundPaise: input.amountPaise,
        reason,
        idempotencyKey: key,
        createdBy: actor.id,
      })
      .returning();

    const base = { orderId: order.id, sourceType: "financial_adjustments", sourceId: adjustment.id, reference: refund.transaction.id, entryType: "REFUND" as const };
    await postLedger(
      [
        // The platform holds customer money, so it pays the refund out...
        { ...base, entityType: "PLATFORM", direction: "DEBIT", amountPaise: input.amountPaise, key: `adj:${adjustment.id}:platform-refund` },
        // ...and recovers the shop's share from the shop.
        { ...base, entityType: "SHOP", entityId: order.shopId, direction: "DEBIT", amountPaise: shopShare, key: `adj:${adjustment.id}:shop` },
        { ...base, entityType: "PLATFORM", direction: "CREDIT", amountPaise: shopShare, key: `adj:${adjustment.id}:platform-recovery` },
      ],
      actor.id,
      tx,
    );

    const remaining = order.totalPaise - input.amountPaise;
    await tx
      .update(orders)
      .set({
        totalPaise: remaining,
        subtotalPaise: Math.max(0, order.subtotalPaise - Math.min(input.amountPaise, order.subtotalPaise)),
        refundedPaise: order.refundedPaise + input.amountPaise,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.ORDER_REFUNDED_AFTER_DELIVERY,
        entityType: "order",
        entityId: order.id,
        previousValue: { totalPaise: order.totalPaise, refundedPaise: order.refundedPaise },
        newValue: { amountPaise: input.amountPaise, chargeTo: type, shopShare, reason, adjustmentId: adjustment.id },
      },
      tx,
    );
    return { order, adjustment, fullyRefunded: remaining === 0 };
  });

  if (result.fullyRefunded) {
    // Imported lazily: orders.ts imports this module for the DELIVERED hook.
    const { updateOrderStatus } = await import("./orders");
    await updateOrderStatus(result.order.id, "REFUND_PENDING", actor, "Full refund after delivery");
    await updateOrderStatus(result.order.id, "REFUNDED", actor, "Wallet refunded");
  }
  return result.adjustment;
}

const ADJUSTMENT_PARTY: Record<Exclude<AdjustmentType, "REFUND_SHOP" | "REFUND_PLATFORM">, FinancialParty> = {
  SHOP_ADJUSTMENT: "SHOP",
  RIDER_ADJUSTMENT: "RIDER",
  DELIVERY_ADJUSTMENT: "RIDER",
  MARKETPLACE_ADJUSTMENT: "PLATFORM",
};

export interface AdjustmentInput {
  type: keyof typeof ADJUSTMENT_PARTY;
  shopId?: string | null;
  deliveryPartnerId?: string | null;
  orderNumber?: string | null;
  /** + owed to the shop/rider (or platform gain), − recovered (or platform cost). */
  amountPaise: number;
  reason: string;
  requestId: string;
}

/** Shop, rider (incl. delivery-related) or marketplace correction; flows into the next batch. */
export async function recordAdjustment(input: AdjustmentInput, actor: Actor): Promise<FinancialAdjustment> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationFailed("Give a reason for the adjustment.");
  if (!Number.isInteger(input.amountPaise) || input.amountPaise === 0) {
    throw validationFailed("Adjustment amount must be a non-zero number of paise.");
  }
  const party = ADJUSTMENT_PARTY[input.type];
  if (!party) throw validationFailed("Unknown adjustment type.");
  if (party === "SHOP" && !input.shopId) throw validationFailed("Choose the shop.");
  if (party === "RIDER" && !input.deliveryPartnerId) throw validationFailed("Choose the delivery partner.");

  const order = input.orderNumber
    ? await db.query.orders.findFirst({ where: eq(orders.orderNumber, input.orderNumber.trim()) })
    : null;
  if (input.orderNumber && !order) throw notFound("Order");

  const key = `adjustment:${input.type}:${input.requestId}`;
  return db.transaction(async (tx) => {
    const existing = await tx.query.financialAdjustments.findFirst({ where: eq(financialAdjustments.idempotencyKey, key) });
    if (existing) return existing;

    const [row] = await tx
      .insert(financialAdjustments)
      .values({
        type: input.type,
        party,
        status: party === "PLATFORM" ? "RECORDED" : "PENDING",
        shopId: party === "SHOP" ? input.shopId! : order?.shopId ?? null,
        deliveryPartnerId: party === "RIDER" ? input.deliveryPartnerId! : null,
        orderId: order?.id ?? null,
        amountPaise: input.amountPaise,
        reason,
        idempotencyKey: key,
        createdBy: actor.id,
      })
      .returning();

    const entityId = party === "SHOP" ? row.shopId : party === "RIDER" ? row.deliveryPartnerId : null;
    const base = { orderId: row.orderId, sourceType: "financial_adjustments", sourceId: row.id, entryType: "ADJUSTMENT" as const };
    await postLedger(
      party === "PLATFORM"
        ? [{ ...base, entityType: "PLATFORM", direction: "CREDIT", amountPaise: input.amountPaise, key: `adj:${row.id}:platform` }]
        : [
            { ...base, entityType: party, entityId, direction: "CREDIT", amountPaise: input.amountPaise, key: `adj:${row.id}:party` },
            { ...base, entityType: "PLATFORM", direction: "DEBIT", amountPaise: input.amountPaise, key: `adj:${row.id}:platform` },
          ],
      actor.id,
      tx,
    );

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.FINANCIAL_ADJUSTMENT_RECORDED,
        entityType: "financial_adjustment",
        entityId: row.id,
        newValue: { type: input.type, party, shopId: row.shopId, deliveryPartnerId: row.deliveryPartnerId, orderId: row.orderId, amountPaise: input.amountPaise, reason },
      },
      tx,
    );
    return row;
  });
}

/* ==================================================== weekly batches */

/** Monday of the week before the current one (the default week to settle). */
export function previousWeekStart(now: Date = new Date()): IsoDate {
  const today = todayIn(getEnv().APP_TIMEZONE, now);
  const thisMonday = addDays(today, -(isoWeekday(today) - 1));
  return addDays(thisMonday, -7);
}

/** Instant at which `date` begins in the app time zone. */
function startOf(date: IsoDate) {
  return sql`((${date})::date::timestamp AT TIME ZONE ${getEnv().APP_TIMEZONE})`;
}

function assertMonday(weekStart: string): { start: IsoDate; end: IsoDate } {
  const start = assertIsoDate(weekStart);
  if (isoWeekday(start) !== 1) throw validationFailed("A settlement week starts on a Monday.");
  return { start, end: addDays(start, 7) };
}

/**
 * PENDING shop settlements for the week starting `weekStart` (Monday): every
 * unsettled delivered order up to the week's end that has cleared the hold
 * and is not disputed / refund-pending, plus every pending shop adjustment.
 * Older unsettled items roll in. Safe to re-run.
 */
export async function prepareShopSettlements(weekStart: string, actor: SystemOrActor): Promise<ShopSettlement[]> {
  const { start, end } = assertMonday(weekStart);

  return db.transaction(async (tx) => {
    const eligibleOrders = await tx
      .select({ financial: orderFinancials })
      .from(orderFinancials)
      .innerJoin(orders, eq(orderFinancials.orderId, orders.id))
      .where(
        and(
          isNull(orderFinancials.settlementId),
          lt(orderFinancials.deliveredAt, startOf(end)),
          lt(orderFinancials.deliveredAt, sql`now() - make_interval(days => ${SETTLEMENT_HOLD_DAYS})`),
          inArray(orders.status, ["DELIVERED", "REFUNDED"]),
        ),
      )
      .for("update", { of: orderFinancials });
    const eligibleAdjustments = await tx
      .select()
      .from(financialAdjustments)
      .where(
        and(
          eq(financialAdjustments.party, "SHOP"),
          eq(financialAdjustments.status, "PENDING"),
          isNull(financialAdjustments.settlementId),
          lt(financialAdjustments.createdAt, startOf(end)),
        ),
      )
      .for("update");

    const shopIds = new Set([
      ...eligibleOrders.map((r) => r.financial.shopId),
      ...eligibleAdjustments.map((a) => a.shopId!),
    ]);
    const created: ShopSettlement[] = [];
    for (const shopId of shopIds) {
      const lines = eligibleOrders.filter((r) => r.financial.shopId === shopId).map((r) => r.financial);
      const adjustments = eligibleAdjustments.filter((a) => a.shopId === shopId);
      const goodsPaise = lines.reduce((sum, l) => sum + l.goodsPaise, 0);
      const commissionPaise = lines.reduce((sum, l) => sum + l.commissionPaise, 0);
      const refundsPaise = adjustments.filter((a) => a.type === "REFUND_SHOP").reduce((sum, a) => sum + a.amountPaise, 0);
      const adjustmentsPaise = adjustments.filter((a) => a.type !== "REFUND_SHOP").reduce((sum, a) => sum + a.amountPaise, 0);
      if (lines.length === 0 && adjustments.length === 0) continue;

      const [settlement] = await tx
        .insert(shopSettlements)
        .values({
          shopId,
          periodStart: start,
          periodEnd: end,
          orderCount: lines.length,
          goodsPaise,
          commissionPaise,
          refundsPaise,
          adjustmentsPaise,
          netPayablePaise: goodsPaise - commissionPaise + refundsPaise + adjustmentsPaise,
          createdBy: actor.id,
        })
        .returning();
      if (lines.length > 0) {
        await tx
          .update(orderFinancials)
          .set({ settlementId: settlement.id })
          .where(inArray(orderFinancials.orderId, lines.map((l) => l.orderId)));
      }
      if (adjustments.length > 0) {
        await tx
          .update(financialAdjustments)
          .set({ settlementId: settlement.id, status: "SETTLED" })
          .where(inArray(financialAdjustments.id, adjustments.map((a) => a.id)));
      }
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.SETTLEMENT_PREPARED,
          entityType: "shop_settlement",
          entityId: settlement.id,
          newValue: { shopId, periodStart: start, netPayablePaise: settlement.netPayablePaise, orders: lines.length },
        },
        tx,
      );
      created.push(settlement);
    }
    return created;
  });
}

/** PENDING rider payouts: unpaid earnings and pending rider/delivery adjustments before the week's end. */
export async function prepareRiderPayouts(weekStart: string, actor: SystemOrActor): Promise<RiderPayout[]> {
  const { start, end } = assertMonday(weekStart);

  return db.transaction(async (tx) => {
    const earnings = await tx
      .select()
      .from(deliveryPartnerEarnings)
      .where(and(isNull(deliveryPartnerEarnings.payoutId), lt(deliveryPartnerEarnings.createdAt, startOf(end))))
      .for("update");
    const adjustments = await tx
      .select()
      .from(financialAdjustments)
      .where(
        and(
          eq(financialAdjustments.party, "RIDER"),
          eq(financialAdjustments.status, "PENDING"),
          isNull(financialAdjustments.payoutId),
          lt(financialAdjustments.createdAt, startOf(end)),
        ),
      )
      .for("update");

    const partnerIds = new Set([...earnings.map((e) => e.deliveryPartnerId), ...adjustments.map((a) => a.deliveryPartnerId!)]);
    const created: RiderPayout[] = [];
    for (const partnerId of partnerIds) {
      const mine = earnings.filter((e) => e.deliveryPartnerId === partnerId);
      const myAdjustments = adjustments.filter((a) => a.deliveryPartnerId === partnerId);
      const grossPaise = mine.reduce((sum, e) => sum + e.totalPaise, 0);
      const adjustmentsPaise = myAdjustments.reduce((sum, a) => sum + a.amountPaise, 0);
      const [payout] = await tx
        .insert(riderPayouts)
        .values({
          deliveryPartnerId: partnerId,
          periodStart: start,
          periodEnd: end,
          earningsCount: mine.length,
          grossPaise,
          adjustmentsPaise,
          amountPaise: grossPaise + adjustmentsPaise,
          createdBy: actor.id,
        })
        .returning();
      if (mine.length > 0) {
        await tx
          .update(deliveryPartnerEarnings)
          .set({ payoutId: payout.id })
          .where(inArray(deliveryPartnerEarnings.id, mine.map((e) => e.id)));
      }
      if (myAdjustments.length > 0) {
        await tx
          .update(financialAdjustments)
          .set({ payoutId: payout.id, status: "SETTLED" })
          .where(inArray(financialAdjustments.id, myAdjustments.map((a) => a.id)));
      }
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.RIDER_PAYOUT_PREPARED,
          entityType: "rider_payout",
          entityId: payout.id,
          newValue: { deliveryPartnerId: partnerId, amountPaise: payout.amountPaise, earnings: mine.length },
        },
        tx,
      );
      created.push(payout);
    }
    return created;
  });
}

export type BatchAction = "approve" | "process" | "pay" | "fail" | "reverse" | "cancel";

const BATCH_STEPS: Record<BatchAction, { from: PayoutStatus[]; to: PayoutStatus }> = {
  approve: { from: ["PENDING"], to: "ELIGIBLE" },
  process: { from: ["ELIGIBLE", "FAILED"], to: "PROCESSING" },
  pay: { from: ["PROCESSING"], to: "PAID" },
  fail: { from: ["PROCESSING"], to: "FAILED" },
  reverse: { from: ["PAID"], to: "REVERSED" },
  cancel: { from: ["PENDING", "ELIGIBLE"], to: "CANCELLED" },
};

function stepFields(action: BatchAction, actor: Actor, note: string | undefined) {
  const now = new Date();
  switch (action) {
    case "approve":
      return { approvedBy: actor.id, approvedAt: now };
    case "process":
      return { processingAt: now, failureReason: null };
    case "pay":
      return { paidBy: actor.id, paidAt: now, paymentReference: note };
    case "fail":
      return { failedAt: now, failureReason: note };
    case "reverse":
      return { reversedAt: now, failureReason: note };
    default:
      return {};
  }
}

function assertNote(action: BatchAction, note: string | undefined) {
  if (action === "pay" && !note) throw validationFailed("Enter the bank / UTR reference of the payment.");
  if ((action === "fail" || action === "reverse") && !note) throw validationFailed("Say why the bank rejected or reversed it.");
}

/**
 * Settlement lifecycle (Part D/F). PAID posts the payout to the journal;
 * CANCELLED/REVERSED release the orders and adjustments so the next batch
 * picks them up (a reversal also posts a REVERSAL entry).
 */
export async function decideShopSettlement(
  settlementId: string,
  action: BatchAction,
  actor: Actor,
  noteOrReference?: string,
): Promise<ShopSettlement> {
  const note = noteOrReference?.trim() || undefined;
  assertNote(action, note);
  const step = BATCH_STEPS[action];

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(shopSettlements).where(eq(shopSettlements.id, settlementId)).for("update");
    if (!current) throw notFound("Settlement");
    if (!step.from.includes(current.status)) {
      throw conflict(`A ${current.status.toLowerCase()} settlement cannot move to ${step.to.toLowerCase()}.`);
    }
    const [updated] = await tx
      .update(shopSettlements)
      .set({ status: step.to, ...stepFields(action, actor, note), updatedAt: new Date() })
      .where(eq(shopSettlements.id, settlementId))
      .returning();

    if (action === "cancel" || action === "reverse") {
      await tx.update(orderFinancials).set({ settlementId: null }).where(eq(orderFinancials.settlementId, settlementId));
      await tx
        .update(financialAdjustments)
        .set({ settlementId: null, status: "PENDING" })
        .where(eq(financialAdjustments.settlementId, settlementId));
    }
    const base = { sourceType: "shop_settlements", sourceId: settlementId, entityType: "SHOP" as const, entityId: current.shopId };
    if (action === "pay") {
      await postLedger(
        [{ ...base, entryType: "SHOP_SETTLEMENT", direction: "DEBIT", amountPaise: current.netPayablePaise, reference: note, key: `settlement:${settlementId}:paid` }],
        actor.id,
        tx,
      );
    }
    if (action === "reverse") {
      await postLedger(
        [{ ...base, entryType: "REVERSAL", direction: "CREDIT", amountPaise: current.netPayablePaise, reference: current.paymentReference, key: `settlement:${settlementId}:reversed` }],
        actor.id,
        tx,
      );
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SETTLEMENT_STATUS_CHANGED,
        entityType: "shop_settlement",
        entityId: settlementId,
        previousValue: { status: current.status },
        newValue: { status: step.to, note: note ?? null },
      },
      tx,
    );
    return updated;
  });
}

export async function decideRiderPayout(
  payoutId: string,
  action: BatchAction,
  actor: Actor,
  noteOrReference?: string,
): Promise<RiderPayout> {
  const note = noteOrReference?.trim() || undefined;
  assertNote(action, note);
  const step = BATCH_STEPS[action];

  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(riderPayouts).where(eq(riderPayouts.id, payoutId)).for("update");
    if (!current) throw notFound("Payout");
    if (!step.from.includes(current.status)) {
      throw conflict(`A ${current.status.toLowerCase()} payout cannot move to ${step.to.toLowerCase()}.`);
    }
    const [updated] = await tx
      .update(riderPayouts)
      .set({ status: step.to, ...stepFields(action, actor, note), updatedAt: new Date() })
      .where(eq(riderPayouts.id, payoutId))
      .returning();

    if (action === "cancel" || action === "reverse") {
      await tx.update(deliveryPartnerEarnings).set({ payoutId: null }).where(eq(deliveryPartnerEarnings.payoutId, payoutId));
      await tx
        .update(financialAdjustments)
        .set({ payoutId: null, status: "PENDING" })
        .where(eq(financialAdjustments.payoutId, payoutId));
    }
    const base = { sourceType: "rider_payouts", sourceId: payoutId, entityType: "RIDER" as const, entityId: current.deliveryPartnerId };
    if (action === "pay") {
      await postLedger(
        [{ ...base, entryType: "RIDER_PAYOUT", direction: "DEBIT", amountPaise: current.amountPaise, reference: note, key: `payout:${payoutId}:paid` }],
        actor.id,
        tx,
      );
    }
    if (action === "reverse") {
      await postLedger(
        [{ ...base, entryType: "REVERSAL", direction: "CREDIT", amountPaise: current.amountPaise, reference: current.paymentReference, key: `payout:${payoutId}:reversed` }],
        actor.id,
        tx,
      );
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.RIDER_PAYOUT_STATUS_CHANGED,
        entityType: "rider_payout",
        entityId: payoutId,
        previousValue: { status: current.status },
        newValue: { status: step.to, note: note ?? null },
      },
      tx,
    );
    return updated;
  });
}

/* ========================================================= reporting */

export async function listShopSettlements(options: { shopId?: string; limit?: number } = {}) {
  return db
    .select({ settlement: shopSettlements, shopName: shops.name })
    .from(shopSettlements)
    .innerJoin(shops, eq(shopSettlements.shopId, shops.id))
    .where(options.shopId ? eq(shopSettlements.shopId, options.shopId) : undefined)
    .orderBy(desc(shopSettlements.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

export async function listRiderPayouts(options: { deliveryPartnerId?: string; limit?: number } = {}) {
  return db
    .select({ payout: riderPayouts, partnerName: deliveryPartners.fullName })
    .from(riderPayouts)
    .innerJoin(deliveryPartners, eq(riderPayouts.deliveryPartnerId, deliveryPartners.id))
    .where(options.deliveryPartnerId ? eq(riderPayouts.deliveryPartnerId, options.deliveryPartnerId) : undefined)
    .orderBy(desc(riderPayouts.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

/** A shop's delivered orders not yet in a settlement, and its pending adjustments. */
export async function getShopPendingPayable(shopId: string) {
  const [orderTotals] = await db
    .select({
      orders: sql<number>`count(*)::int`,
      goods: sql<number>`coalesce(sum(${orderFinancials.goodsPaise}), 0)::bigint`,
      commission: sql<number>`coalesce(sum(${orderFinancials.commissionPaise}), 0)::bigint`,
    })
    .from(orderFinancials)
    .where(and(eq(orderFinancials.shopId, shopId), isNull(orderFinancials.settlementId)));
  const [adjustmentTotals] = await db
    .select({
      refunds: sql<number>`coalesce(sum(${financialAdjustments.amountPaise}) filter (where ${financialAdjustments.type} = 'REFUND_SHOP'), 0)::bigint`,
      other: sql<number>`coalesce(sum(${financialAdjustments.amountPaise}) filter (where ${financialAdjustments.type} <> 'REFUND_SHOP'), 0)::bigint`,
    })
    .from(financialAdjustments)
    .where(
      and(
        eq(financialAdjustments.party, "SHOP"),
        eq(financialAdjustments.shopId, shopId),
        eq(financialAdjustments.status, "PENDING"),
      ),
    );
  const goods = Number(orderTotals.goods);
  const commission = Number(orderTotals.commission);
  const refunds = Number(adjustmentTotals.refunds);
  const adjustments = Number(adjustmentTotals.other);
  return {
    orders: orderTotals.orders,
    goodsPaise: goods,
    commissionPaise: commission,
    refundsPaise: refunds,
    adjustmentsPaise: adjustments,
    netPaise: goods - commission + refunds + adjustments,
  };
}

export async function listOrderFinancialsForShop(shopId: string, limit = 50) {
  return db
    .select({ financial: orderFinancials, orderNumber: orders.orderNumber, settlementStatus: shopSettlements.status })
    .from(orderFinancials)
    .innerJoin(orders, eq(orderFinancials.orderId, orders.id))
    .leftJoin(shopSettlements, eq(orderFinancials.settlementId, shopSettlements.id))
    .where(eq(orderFinancials.shopId, shopId))
    .orderBy(desc(orderFinancials.deliveredAt))
    .limit(limit);
}

export async function listAdjustments(options: { shopId?: string; deliveryPartnerId?: string; limit?: number } = {}) {
  const conditions = [
    options.shopId ? and(eq(financialAdjustments.party, "SHOP"), eq(financialAdjustments.shopId, options.shopId)) : undefined,
    options.deliveryPartnerId ? eq(financialAdjustments.deliveryPartnerId, options.deliveryPartnerId) : undefined,
  ].filter(Boolean);
  return db
    .select({ adjustment: financialAdjustments, orderNumber: orders.orderNumber })
    .from(financialAdjustments)
    .leftJoin(orders, eq(financialAdjustments.orderId, orders.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(financialAdjustments.createdAt))
    .limit(Math.min(options.limit ?? 50, 500));
}

/** Rider view (Part E): each earning with its order, delivery and payout status; pending payable. */
export async function getRiderEarningsView(deliveryPartnerId: string, limit = 50) {
  const earnings = await db
    .select({
      earning: deliveryPartnerEarnings,
      orderNumber: orders.orderNumber,
      deliveryStatus: deliveryOrders.status,
      payoutStatus: riderPayouts.status,
    })
    .from(deliveryPartnerEarnings)
    .innerJoin(deliveryOrders, eq(deliveryPartnerEarnings.deliveryOrderId, deliveryOrders.id))
    .innerJoin(orders, eq(deliveryOrders.orderId, orders.id))
    .leftJoin(riderPayouts, eq(deliveryPartnerEarnings.payoutId, riderPayouts.id))
    .where(eq(deliveryPartnerEarnings.deliveryPartnerId, deliveryPartnerId))
    .orderBy(desc(deliveryPartnerEarnings.createdAt))
    .limit(limit);
  const [pendingEarnings] = await db
    .select({ total: sql<number>`coalesce(sum(${deliveryPartnerEarnings.totalPaise}), 0)::bigint` })
    .from(deliveryPartnerEarnings)
    .where(and(eq(deliveryPartnerEarnings.deliveryPartnerId, deliveryPartnerId), isNull(deliveryPartnerEarnings.payoutId)));
  const [pendingAdjustments] = await db
    .select({ total: sql<number>`coalesce(sum(${financialAdjustments.amountPaise}), 0)::bigint` })
    .from(financialAdjustments)
    .where(and(eq(financialAdjustments.deliveryPartnerId, deliveryPartnerId), eq(financialAdjustments.status, "PENDING")));
  return {
    earnings: earnings.map((e) => ({
      ...e.earning,
      orderNumber: e.orderNumber,
      deliveryStatus: e.deliveryStatus,
      status: e.payoutStatus ?? "UNPAID",
    })),
    pendingEarningsPaise: Number(pendingEarnings.total),
    pendingAdjustmentsPaise: Number(pendingAdjustments.total),
  };
}

/** Admin: what each shop and each rider is currently owed (not yet batched). */
export async function getPayablesOverview() {
  const shopRows = await db
    .select({
      shopId: orderFinancials.shopId,
      shopName: shops.name,
      orders: sql<number>`count(*)::int`,
      payable: sql<number>`coalesce(sum(${orderFinancials.shopPayablePaise}), 0)::bigint`,
    })
    .from(orderFinancials)
    .innerJoin(shops, eq(orderFinancials.shopId, shops.id))
    .where(isNull(orderFinancials.settlementId))
    .groupBy(orderFinancials.shopId, shops.name);
  const riderRows = await db
    .select({
      deliveryPartnerId: deliveryPartnerEarnings.deliveryPartnerId,
      partnerName: deliveryPartners.fullName,
      deliveries: sql<number>`count(*)::int`,
      earnings: sql<number>`coalesce(sum(${deliveryPartnerEarnings.totalPaise}), 0)::bigint`,
    })
    .from(deliveryPartnerEarnings)
    .innerJoin(deliveryPartners, eq(deliveryPartnerEarnings.deliveryPartnerId, deliveryPartners.id))
    .where(isNull(deliveryPartnerEarnings.payoutId))
    .groupBy(deliveryPartnerEarnings.deliveryPartnerId, deliveryPartners.fullName);
  return {
    shops: shopRows.map((r) => ({ ...r, payable: Number(r.payable) })),
    riders: riderRows.map((r) => ({ ...r, earnings: Number(r.earnings) })),
  };
}

export interface FinanceSummary {
  from: IsoDate;
  to: IsoDate;
  deliveredOrders: number;
  gmvPaise: number;
  goodsPaise: number;
  discountPaise: number;
  commissionPaise: number;
  deliveryFeeRevenuePaise: number;
  riderCostPaise: number;
  refundsAfterDeliveryPaise: number;
  platformRefundCostPaise: number;
  /** All wallet refunds for orders in the window (cancellations, removed items, after delivery). */
  walletRefundsPaise: number;
  /** Gateway top-ups received (successful payments). */
  gatewayPaymentsPaise: number;
  /** commission + delivery fees − rider cost − discounts − platform-borne refunds. */
  platformNetPaise: number;
  paidOrders: number;
  paidOrderValuePaise: number;
  cancelledOrders: number;
}

/** Marketplace figures over [from, to) (Part J). */
export async function getFinanceSummary(fromDate: string, toDate: string): Promise<FinanceSummary> {
  const from = assertIsoDate(fromDate);
  const to = assertIsoDate(toDate);
  if (to <= from) throw validationFailed("The end date must be after the start date.");
  const inWindow = (column: Parameters<typeof gte>[0]) => and(gte(column, startOf(from)), lt(column, startOf(to)));

  const [delivered] = await db
    .select({
      count: sql<number>`count(*)::int`,
      gmv: sql<number>`coalesce(sum(${orderFinancials.gmvPaise}), 0)::bigint`,
      goods: sql<number>`coalesce(sum(${orderFinancials.goodsPaise}), 0)::bigint`,
      discount: sql<number>`coalesce(sum(${orderFinancials.discountPaise}), 0)::bigint`,
      commission: sql<number>`coalesce(sum(${orderFinancials.commissionPaise}), 0)::bigint`,
      fees: sql<number>`coalesce(sum(${orderFinancials.deliveryFeePaise}), 0)::bigint`,
    })
    .from(orderFinancials)
    .where(inWindow(orderFinancials.deliveredAt));
  const [riders] = await db
    .select({ cost: sql<number>`coalesce(sum(${deliveryPartnerEarnings.totalPaise}), 0)::bigint` })
    .from(deliveryPartnerEarnings)
    .where(inWindow(deliveryPartnerEarnings.createdAt));
  const [adjustments] = await db
    .select({
      refunds: sql<number>`coalesce(sum(${financialAdjustments.customerRefundPaise}), 0)::bigint`,
      platformRefunds: sql<number>`coalesce(sum(${financialAdjustments.customerRefundPaise}) filter (where ${financialAdjustments.type} = 'REFUND_PLATFORM'), 0)::bigint`,
    })
    .from(financialAdjustments)
    .where(inWindow(financialAdjustments.createdAt));
  const [walletRefunds] = await db
    .select({ total: sql<number>`coalesce(sum(${walletTransactions.amountPaise}), 0)::bigint` })
    .from(walletTransactions)
    .where(and(eq(walletTransactions.type, "REFUND"), sql`${walletTransactions.orderId} is not null`, inWindow(walletTransactions.createdAt)));
  const [gateway] = await db
    .select({ total: sql<number>`coalesce(sum(${payments.amountPaise}), 0)::bigint` })
    .from(payments)
    .where(and(eq(payments.status, "SUCCESS"), inWindow(payments.createdAt)));
  const [paid] = await db
    .select({
      count: sql<number>`count(*)::int`,
      value: sql<number>`coalesce(sum(${orders.totalPaise} + ${orders.refundedPaise}), 0)::bigint`,
      cancelled: sql<number>`count(*) filter (where ${orders.status} in ('CANCELLED', 'REFUNDED'))::int`,
    })
    .from(orders)
    .where(inWindow(orders.paidAt));

  const commission = Number(delivered.commission);
  const fees = Number(delivered.fees);
  const riderCost = Number(riders.cost);
  const discount = Number(delivered.discount);
  const platformRefund = Number(adjustments.platformRefunds);
  return {
    from,
    to,
    deliveredOrders: delivered.count,
    gmvPaise: Number(delivered.gmv),
    goodsPaise: Number(delivered.goods),
    discountPaise: discount,
    commissionPaise: commission,
    deliveryFeeRevenuePaise: fees,
    riderCostPaise: riderCost,
    refundsAfterDeliveryPaise: Number(adjustments.refunds),
    platformRefundCostPaise: platformRefund,
    walletRefundsPaise: Number(walletRefunds.total),
    gatewayPaymentsPaise: Number(gateway.total),
    platformNetPaise: commission + fees - riderCost - discount - platformRefund,
    paidOrders: paid.count,
    paidOrderValuePaise: Number(paid.value),
    cancelledOrders: paid.cancelled,
  };
}

/* ==================================================== reconciliation */

interface CheckResult {
  entityType: ReconciliationEntity;
  entityId: string;
  reference: string;
  checkType: string;
  expectedPaise: number | null;
  actualPaise: number | null;
  status: Exclude<ReconciliationStatus, "RECONCILED">;
  detail: string | null;
}

function compare(expected: number, actual: number): CheckResult["status"] {
  if (actual === expected) return "MATCHED";
  if (actual === 0 && expected !== 0) return "UNMATCHED";
  if (actual > 0 && actual < expected) return "PARTIAL";
  return "EXCEPTION";
}

/**
 * GS-031 / Part H: runs every check for [from, to) and upserts one record
 * per (entity, check). A record someone marked RECONCILED stays RECONCILED
 * unless the figures later agree (then MATCHED). Checks:
 *  ORDER   ORDER_PAYMENT      — wallet net charge = what the order still holds
 *  ORDER   DELIVERED_SNAPSHOT — delivered orders have a financial snapshot
 *  PAYMENT GATEWAY_CREDIT     — successful gateway payment credited exactly once
 *  PAYMENT GATEWAY_PENDING    — gateway payment stuck in CREATED/PENDING > 30 min
 *  RIDER   EARNING_PRESENT    — completed/failed/after-pickup deliveries have an earning
 *  SETTLEMENT / PAYOUT TOTAL  — batch totals still equal their linked lines
 */
export async function runReconciliation(fromDate: string, toDate: string, actor: SystemOrActor) {
  const from = assertIsoDate(fromDate);
  const to = assertIsoDate(toDate);
  const inWindow = (column: Parameters<typeof gte>[0]) => and(gte(column, startOf(from)), lt(column, startOf(to)));
  const results: CheckResult[] = [];

  const paidOrders = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalPaise: orders.totalPaise,
      walletNet: sql<number>`coalesce((select -sum(${walletTransactions.amountPaise}) from ${walletTransactions}
        where ${walletTransactions.orderId} = ${orders.id} and ${walletTransactions.status} = 'COMPLETED'), 0)::bigint`,
      hasSnapshot: sql<boolean>`exists(select 1 from ${orderFinancials} where ${orderFinancials.orderId} = ${orders.id})`,
    })
    .from(orders)
    .where(inWindow(orders.paidAt));
  for (const o of paidOrders) {
    const expected = o.status === "CANCELLED" || o.status === "REFUNDED" ? 0 : o.totalPaise;
    const actual = Number(o.walletNet);
    results.push({
      entityType: "ORDER",
      entityId: o.id,
      reference: o.orderNumber,
      checkType: "ORDER_PAYMENT",
      expectedPaise: expected,
      actualPaise: actual,
      status: compare(expected, actual),
      detail: actual === expected ? null : `Order is ${o.status}; wallet net charge differs from what the order holds.`,
    });
    if (o.status === "DELIVERED") {
      results.push({
        entityType: "ORDER",
        entityId: o.id,
        reference: o.orderNumber,
        checkType: "DELIVERED_SNAPSHOT",
        expectedPaise: null,
        actualPaise: null,
        status: o.hasSnapshot ? "MATCHED" : "EXCEPTION",
        detail: o.hasSnapshot ? null : "Delivered but no settlement snapshot (delivered before the finance ledger, or the hook failed).",
      });
    }
  }

  const gatewayPayments = await db
    .select({
      id: payments.id,
      gatewayOrderId: payments.gatewayOrderId,
      status: payments.status,
      amountPaise: payments.amountPaise,
      createdAt: payments.createdAt,
      credited: sql<number>`coalesce((select sum(${walletTransactions.amountPaise}) from ${walletTransactions}
        where ${walletTransactions.paymentId} = ${payments.id} and ${walletTransactions.type} = 'TOP_UP'), 0)::bigint`,
    })
    .from(payments)
    .where(inWindow(payments.createdAt));
  for (const p of gatewayPayments) {
    const credited = Number(p.credited);
    if (p.status === "SUCCESS") {
      results.push({
        entityType: "PAYMENT",
        entityId: p.id,
        reference: p.gatewayOrderId,
        checkType: "GATEWAY_CREDIT",
        expectedPaise: p.amountPaise,
        actualPaise: credited,
        status: compare(p.amountPaise, credited),
        detail:
          credited === p.amountPaise
            ? null
            : credited > p.amountPaise
              ? "Wallet credited more than the gateway amount (duplicate credit?)."
              : "Gateway reports success but the wallet credit is missing or short.",
      });
    } else if ((p.status === "CREATED" || p.status === "PENDING") && p.createdAt.getTime() < Date.now() - 30 * 60_000) {
      results.push({
        entityType: "PAYMENT",
        entityId: p.id,
        reference: p.gatewayOrderId,
        checkType: "GATEWAY_PENDING",
        expectedPaise: p.amountPaise,
        actualPaise: credited,
        status: credited > 0 ? "EXCEPTION" : "UNMATCHED",
        detail: "Gateway payment still pending after 30 minutes — check the gateway dashboard.",
      });
    }
  }

  const deliveries = await db
    .select({
      id: deliveryOrders.id,
      orderNumber: orders.orderNumber,
      status: deliveryOrders.status,
      hasEarning: sql<boolean>`exists(select 1 from ${deliveryPartnerEarnings} where ${deliveryPartnerEarnings.deliveryOrderId} = ${deliveryOrders.id})`,
    })
    .from(deliveryOrders)
    .innerJoin(orders, eq(deliveryOrders.orderId, orders.id))
    .where(
      and(
        inWindow(deliveryOrders.updatedAt),
        or(
          inArray(deliveryOrders.status, ["DELIVERED", "FAILED"]),
          and(eq(deliveryOrders.status, "CANCELLED"), sql`${deliveryOrders.pickedUpAt} is not null`),
        ),
      ),
    );
  for (const d of deliveries) {
    results.push({
      entityType: "RIDER",
      entityId: d.id,
      reference: d.orderNumber,
      checkType: "EARNING_PRESENT",
      expectedPaise: null,
      actualPaise: null,
      status: d.hasEarning ? "MATCHED" : "UNMATCHED",
      detail: d.hasEarning ? null : `Delivery ${d.status.toLowerCase()} but the rider has no earning recorded.`,
    });
  }

  const settlements = await db
    .select({
      id: shopSettlements.id,
      net: shopSettlements.netPayablePaise,
      lines: sql<number>`coalesce((select sum(${orderFinancials.shopPayablePaise}) from ${orderFinancials}
        where ${orderFinancials.settlementId} = ${shopSettlements.id}), 0)::bigint`,
      adjustments: sql<number>`coalesce((select sum(${financialAdjustments.amountPaise}) from ${financialAdjustments}
        where ${financialAdjustments.settlementId} = ${shopSettlements.id}), 0)::bigint`,
    })
    .from(shopSettlements)
    .where(and(inArray(shopSettlements.status, ["PENDING", "ELIGIBLE", "PROCESSING", "PAID"]), inWindow(shopSettlements.createdAt)));
  for (const s of settlements) {
    const actual = Number(s.lines) + Number(s.adjustments);
    results.push({
      entityType: "SETTLEMENT",
      entityId: s.id,
      reference: s.id,
      checkType: "SETTLEMENT_TOTAL",
      expectedPaise: s.net,
      actualPaise: actual,
      status: actual === s.net ? "MATCHED" : "EXCEPTION",
      detail: actual === s.net ? null : "Settlement total no longer matches its orders and adjustments.",
    });
  }

  const payouts = await db
    .select({
      id: riderPayouts.id,
      amount: riderPayouts.amountPaise,
      earnings: sql<number>`coalesce((select sum(${deliveryPartnerEarnings.totalPaise}) from ${deliveryPartnerEarnings}
        where ${deliveryPartnerEarnings.payoutId} = ${riderPayouts.id}), 0)::bigint`,
      adjustments: sql<number>`coalesce((select sum(${financialAdjustments.amountPaise}) from ${financialAdjustments}
        where ${financialAdjustments.payoutId} = ${riderPayouts.id}), 0)::bigint`,
    })
    .from(riderPayouts)
    .where(and(inArray(riderPayouts.status, ["PENDING", "ELIGIBLE", "PROCESSING", "PAID"]), inWindow(riderPayouts.createdAt)));
  for (const p of payouts) {
    const actual = Number(p.earnings) + Number(p.adjustments);
    results.push({
      entityType: "PAYOUT",
      entityId: p.id,
      reference: p.id,
      checkType: "PAYOUT_TOTAL",
      expectedPaise: p.amount,
      actualPaise: actual,
      status: actual === p.amount ? "MATCHED" : "EXCEPTION",
      detail: actual === p.amount ? null : "Payout total no longer matches its earnings and adjustments.",
    });
  }

  for (const r of results) {
    await db
      .insert(reconciliationRecords)
      .values({ ...r, lastCheckedAt: new Date() })
      .onConflictDoUpdate({
        target: [reconciliationRecords.entityType, reconciliationRecords.entityId, reconciliationRecords.checkType],
        set: {
          reference: r.reference,
          expectedPaise: r.expectedPaise,
          actualPaise: r.actualPaise,
          detail: r.detail,
          lastCheckedAt: new Date(),
          // A person's RECONCILED decision survives re-runs until the figures agree.
          status: sql`case when ${reconciliationRecords.status} = 'RECONCILED' and ${r.status} <> 'MATCHED'
            then 'RECONCILED'::reconciliation_status else ${r.status}::reconciliation_status end`,
        },
      });
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RECONCILIATION_RUN,
    entityType: "reconciliation",
    newValue: { from, to, checked: results.length, counts },
  });
  return { from, to, checked: results.length, counts };
}

export async function listReconciliationRecords(options: {
  statuses?: ReconciliationStatus[];
  entityTypes?: ReconciliationEntity[];
  limit?: number;
} = {}) {
  const conditions = [
    options.statuses?.length ? inArray(reconciliationRecords.status, options.statuses) : undefined,
    options.entityTypes?.length ? inArray(reconciliationRecords.entityType, options.entityTypes) : undefined,
  ].filter(Boolean);
  return db
    .select()
    .from(reconciliationRecords)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(reconciliationRecords.lastCheckedAt))
    .limit(Math.min(options.limit ?? 200, 1000));
}

export async function countReconciliationByStatus(entityTypes?: ReconciliationEntity[]): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: reconciliationRecords.status, count: sql<number>`count(*)::int` })
    .from(reconciliationRecords)
    .where(entityTypes?.length ? inArray(reconciliationRecords.entityType, entityTypes) : undefined)
    .groupBy(reconciliationRecords.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

/** A person investigated and closed a reconciliation record. */
export async function resolveReconciliationRecord(
  id: string,
  note: string,
  actor: Actor,
  allowedEntities?: ReconciliationEntity[],
) {
  const trimmed = note.trim();
  if (trimmed.length < 5) throw validationFailed("Record what was found and done.");
  const [current] = await db.select().from(reconciliationRecords).where(eq(reconciliationRecords.id, id));
  if (!current || (allowedEntities && !allowedEntities.includes(current.entityType))) {
    throw notFound("Reconciliation record");
  }
  if (current.status === "MATCHED" || current.status === "RECONCILED") {
    throw conflict("This record does not need resolving.");
  }
  const [updated] = await db
    .update(reconciliationRecords)
    .set({ status: "RECONCILED", resolvedBy: actor.id, resolvedAt: new Date(), resolutionNote: trimmed })
    .where(eq(reconciliationRecords.id, id))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RECONCILIATION_RESOLVED,
    entityType: "reconciliation_record",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status: "RECONCILED", note: trimmed },
  });
  return updated;
}

/* ================================================ exception queues */

/** Entity types an operator may see in reconciliation (no settlement/payout totals). */
export const OPERATOR_RECONCILIATION_ENTITIES: ReconciliationEntity[] = ["ORDER", "PAYMENT", "RIDER"];

/**
 * Part K/O: operational financial exceptions. `scope: "operator"` leaves out
 * settlement and payout batches (admin-only money); the rest is operational.
 */
export async function listFinancialExceptions(scope: "operator" | "admin") {
  const since = sql`now() - interval '14 days'`;
  const [failedPayments, pendingPayments, refundAttention, recentCancellations, deliveryAdjustments, reconciliation] =
    await Promise.all([
      db
        .select({ id: payments.id, reference: payments.gatewayOrderId, amountPaise: payments.amountPaise, reason: payments.failureReason, at: payments.updatedAt })
        .from(payments)
        .where(and(eq(payments.status, "FAILED"), gte(payments.updatedAt, since)))
        .orderBy(desc(payments.updatedAt))
        .limit(50),
      db
        .select({ id: payments.id, reference: payments.gatewayOrderId, amountPaise: payments.amountPaise, at: payments.createdAt })
        .from(payments)
        .where(and(inArray(payments.status, ["CREATED", "PENDING"]), lt(payments.createdAt, sql`now() - interval '30 minutes'`), gte(payments.createdAt, since)))
        .orderBy(desc(payments.createdAt))
        .limit(50),
      db
        .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, totalPaise: orders.totalPaise, at: orders.updatedAt })
        .from(orders)
        .where(inArray(orders.status, ["REFUND_PENDING", "FAILED", "RETURNED", "DISPUTED", "PAYMENT_FAILED", "WALLET_INSUFFICIENT"]))
        .orderBy(desc(orders.updatedAt))
        .limit(100),
      db
        .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status, refundedPaise: orders.refundedPaise, reason: orders.cancellationReason, at: orders.updatedAt })
        .from(orders)
        .where(and(inArray(orders.status, ["CANCELLED", "REFUNDED"]), gte(orders.updatedAt, since)))
        .orderBy(desc(orders.updatedAt))
        .limit(50),
      db
        .select({ adjustment: financialAdjustments, orderNumber: orders.orderNumber })
        .from(financialAdjustments)
        .leftJoin(orders, eq(financialAdjustments.orderId, orders.id))
        .where(and(inArray(financialAdjustments.type, ["DELIVERY_ADJUSTMENT", "RIDER_ADJUSTMENT"]), gte(financialAdjustments.createdAt, since)))
        .orderBy(desc(financialAdjustments.createdAt))
        .limit(50),
      listReconciliationRecords({
        statuses: ["UNMATCHED", "PARTIAL", "EXCEPTION"],
        entityTypes: scope === "operator" ? OPERATOR_RECONCILIATION_ENTITIES : undefined,
        limit: 200,
      }),
    ]);

  const batchProblems =
    scope === "admin"
      ? {
          settlements: await db
            .select({ settlement: shopSettlements, shopName: shops.name })
            .from(shopSettlements)
            .innerJoin(shops, eq(shopSettlements.shopId, shops.id))
            .where(inArray(shopSettlements.status, ["FAILED", "REVERSED"]))
            .orderBy(desc(shopSettlements.updatedAt))
            .limit(50),
          payouts: await db
            .select({ payout: riderPayouts, partnerName: deliveryPartners.fullName })
            .from(riderPayouts)
            .innerJoin(deliveryPartners, eq(riderPayouts.deliveryPartnerId, deliveryPartners.id))
            .where(inArray(riderPayouts.status, ["FAILED", "REVERSED"]))
            .orderBy(desc(riderPayouts.updatedAt))
            .limit(50),
          // Delivered well past the hold period but still in no settlement ("settlement missing").
          unsettled: await db
            .select({ orderId: orderFinancials.orderId, orderNumber: orders.orderNumber, shopName: shops.name, deliveredAt: orderFinancials.deliveredAt })
            .from(orderFinancials)
            .innerJoin(orders, eq(orderFinancials.orderId, orders.id))
            .innerJoin(shops, eq(orderFinancials.shopId, shops.id))
            .where(and(isNull(orderFinancials.settlementId), lt(orderFinancials.deliveredAt, sql`now() - interval '9 days'`)))
            .limit(100),
        }
      : null;

  return {
    failedPayments,
    pendingPayments,
    refundAttention,
    recentCancellations,
    deliveryAdjustments: deliveryAdjustments.map((d) => ({ ...d.adjustment, orderNumber: d.orderNumber })),
    reconciliation,
    batchProblems,
  };
}

/* ===================================================== traceability */

/**
 * Everything money-related for one order (Part A/L): payment (wallet debit,
 * method WALLET, ledger id as reference), all wallet entries (payment,
 * refunds), the delivered snapshot, adjustments, journal entries, the
 * settlement it went into, the rider's earning, reconciliation results.
 */
export async function getOrderFinancialTrace(orderNumber: string) {
  const order = await db.query.orders.findFirst({ where: eq(orders.orderNumber, orderNumber.trim()) });
  if (!order) throw notFound("Order");
  const [walletEntries, snapshot, adjustments, delivery, ledger, recon] = await Promise.all([
    db.select().from(walletTransactions).where(eq(walletTransactions.orderId, order.id)).orderBy(walletTransactions.createdAt),
    db.query.orderFinancials.findFirst({ where: eq(orderFinancials.orderId, order.id) }),
    db.select().from(financialAdjustments).where(eq(financialAdjustments.orderId, order.id)),
    db.query.deliveryOrders.findFirst({ where: eq(deliveryOrders.orderId, order.id) }),
    listLedgerEntries({ orderId: order.id }),
    db.select().from(reconciliationRecords).where(eq(reconciliationRecords.entityId, order.id)),
  ]);
  const settlement = snapshot?.settlementId
    ? await db.query.shopSettlements.findFirst({ where: eq(shopSettlements.id, snapshot.settlementId) })
    : null;
  const riderEarning = delivery
    ? await db.query.deliveryPartnerEarnings.findFirst({ where: eq(deliveryPartnerEarnings.deliveryOrderId, delivery.id) })
    : null;
  const debit = walletEntries.find((w) => w.amountPaise < 0);
  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      customerId: order.userId,
      shopId: order.shopId,
      source: order.source,
      status: order.status,
      subtotalPaise: order.subtotalPaise,
      deliveryFeePaise: order.deliveryFeePaise,
      totalPaise: order.totalPaise,
      refundedPaise: order.refundedPaise,
      paidAt: order.paidAt,
    },
    payment: debit
      ? {
          method: "WALLET" as const,
          reference: debit.id,
          status: debit.status,
          amountPaise: -debit.amountPaise,
          promotionalPaise: -debit.promotionalAmountPaise,
          paidAt: debit.createdAt,
        }
      : null,
    walletEntries: walletEntries.map((w) => ({
      id: w.id,
      type: w.type,
      amountPaise: w.amountPaise,
      description: w.description,
      createdAt: w.createdAt,
    })),
    snapshot: snapshot ?? null,
    adjustments,
    ledger,
    reconciliation: recon,
    settlement: settlement
      ? { id: settlement.id, status: settlement.status, periodStart: settlement.periodStart, paymentReference: settlement.paymentReference }
      : null,
    riderEarning: riderEarning ? { totalPaise: riderEarning.totalPaise, payoutId: riderEarning.payoutId } : null,
  };
}
