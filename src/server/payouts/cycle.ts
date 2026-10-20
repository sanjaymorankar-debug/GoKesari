/**
 * F10.2.4 (GAP-005) — automated shop payouts: the cycle (batch-2026-10 WS-E).
 *
 * Every payouts.cycleDays days (default 7 from Saturday 17 Oct 2026: every Saturday) counted from payouts.anchorDate,
 * the payout-cycle job closes the last complete cycle and drafts its batch.
 * For each shop the payout is itemised (payout_cycle_lines):
 *
 *   + GOODS            delivered order value (orders delivered before the cycle
 *                      ends, held payouts.holdDays, not in any settlement/cycle)
 *   − COMMISSION       withheld here; 0 (informational) when the shop wallet paid it
 *     DELIVERY_CHARGE  informational: debited from the shop wallet at delivery
 *   − FEE_GST          GST on GoKesari's fees, from its invoice for the cycle
 *                      (platformInvoicing on); + for fees credited back
 *   − PLATFORM_FEE     billing / inventory management charge (platformInvoicing)
 *   − TCS              GST TCS s.52 on the net taxable value (+ on returns)
 *   − TDS              income-tax TDS (s.194-O / s.393) on gross sales (+ on returns)
 *   ± REFUND / ADJUSTMENT  the shop's share of refunds, finance adjustments
 *   ± PLATFORM_NOTE    a credit (+) or debit (−) note issued by hand
 *   − WALLET_TOPUP     tops the shop's prepaid wallet up to payouts.walletTopUpTargetPaise
 *   ± CARRY_FORWARD    a held / reversed amount from an earlier cycle
 *     SEC95_GST, REGISTRATION_FEE  informational
 *
 * Statutory rates are the ones in force on each supply's own date
 * (statutory_rates), so a rate change inside a cycle applies from its day.
 * Each order / refund / carried amount is counted in exactly one cycle (a
 * unique index on the line's source). The weekly settlement (finance.ts) is
 * untouched and stays the path while rule payouts is off; with it on, the
 * weekly job no longer prepares shop settlements.
 *
 * Data split: order_financials / financial_adjustments / tax_invoices live in
 * the customer database and bank_accounts in the platform core; the cycle
 * reads them with separate queries (no cross-database SQL) and writes only
 * seller-side payout rows.
 */
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import { addDays, daysBetween, todayIn, type IsoDate } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { conflict } from "@/lib/errors";
import { isValidGstin } from "@/lib/gst-states";
import { formatPaise } from "@/lib/money";
import { decryptSecret } from "@/lib/pan-crypto";
import { db, isRetryableTransactionError, type DbClient } from "@/server/db";
import {
  bankAccounts,
  creditNotes,
  financialAdjustments,
  orderFinancials,
  orders,
  payoutBatches,
  payoutCycleLines,
  payoutCycles,
  payoutEvents,
  payoutItems,
  platformCreditDebitNotes,
  platformInvoices,
  shopPayments,
  shops,
  taxInvoices,
  type FinancialAdjustment,
  type PayoutBatch,
  type PayoutCycle,
  type PayoutItem,
  type PayoutLineType,
  type Shop,
  type UserRole,
} from "@/server/db/schema";
import { queueDocumentEmail } from "@/server/documents/email";
import { emitEvent } from "@/server/events/emit";
import { issuePlatformInvoice, issuePlatformNote, platformInvoicingStatus, type FeeInput } from "@/server/platform-invoices/service";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { commissionOn } from "@/server/services/finance";
import { financialYearOf } from "@/server/services/invoices";
import { getRule } from "@/server/services/settings";
import { getShopWalletBalance } from "@/server/services/shop-wallet";
import { istDay, sec95RestaurantOn, statutoryResolver, tcsOn, tdsOn, unregisteredRulesOn } from "@/server/statutory/rates";

export interface SystemOrActor {
  id: string | null;
  role: UserRole | null;
}

/**
 * The last complete cycle on `today`: cycles are [anchor + k·days, anchor +
 * (k+1)·days) in IST dates. Null before the first cycle has ended.
 */
export function cycleWindowFor(today: IsoDate, anchor: IsoDate, cycleDays: number): { start: IsoDate; end: IsoDate } | null {
  const elapsed = daysBetween(anchor, today);
  if (cycleDays < 1 || elapsed < cycleDays) return null;
  const current = Math.floor(elapsed / cycleDays);
  const start = addDays(anchor, (current - 1) * cycleDays);
  return { start, end: addDays(start, cycleDays) };
}

export const periodLabel = (cycle: Pick<PayoutCycle, "cycleStart" | "cycleEnd">) => `${cycle.cycleStart} to ${addDays(cycle.cycleEnd, -1)}`;

/** Instant at which `date` begins in the app time zone. */
function startOf(date: IsoDate) {
  return sql`((${date})::date::timestamp AT TIME ZONE ${getEnv().APP_TIMEZONE})`;
}

interface LineDraft {
  shopId: string;
  lineType: PayoutLineType;
  sourceType: string;
  sourceId: string;
  description: string;
  amountPaise: number;
  basePaise?: number | null;
  rateBp?: number | null;
  occurredOn: IsoDate;
  meta?: Record<string, unknown>;
}

const pctOf = (base: number, rateBp: number) => Math.round((base * rateBp) / 10_000);
const splitTax = (amount: number, supply: "INTRA" | "INTER") =>
  supply === "INTER" ? { igst: amount, cgst: 0, sgst: 0 } : { cgst: Math.floor(amount / 2), sgst: amount - Math.floor(amount / 2), igst: 0 };

/** The shop's PAN (from its GSTIN, else the encrypted PAN on record), or null. */
export function shopPan(shop: Pick<Shop, "gstin" | "panNumberEncrypted">): string | null {
  if (isValidGstin(shop.gstin)) return shop.gstin!.slice(2, 12);
  if (!shop.panNumberEncrypted) return null;
  try {
    const pan = decryptSecret(shop.panNumberEncrypted).trim().toUpperCase();
    return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan : null;
  } catch {
    return null;
  }
}

/** GST-registered for TCS: a GSTIN on record (composition dealers included — they are registered persons). */
const isGstRegistered = (shop: Pick<Shop, "gstin">) => isValidGstin(shop.gstin) || /^\d{2}[A-Z0-9]{13}$/.test(shop.gstin ?? "");

export interface CloseCycleResult {
  cycle: PayoutCycle;
  batch: PayoutBatch | null;
  items: PayoutItem[];
  created: boolean;
}

/**
 * Closes the last complete cycle (idempotent: an already closed cycle is
 * returned as it is) and drafts its payout batch. Throws while rule payouts
 * is off. Null when no cycle has ended yet.
 */
export async function closePayoutCycle(options: { today?: IsoDate; actor: SystemOrActor }): Promise<CloseCycleResult | null> {
  const rule = await getRule("payouts");
  if (!rule.enabled) throw conflict("Automated payouts are off (rule payouts.enabled). The weekly settlement is in use.");
  const today = options.today ?? todayIn(getEnv().APP_TIMEZONE);
  const window = cycleWindowFor(today, rule.anchorDate, rule.cycleDays);
  if (!window) return null;
  const existing = await loadCycle(window.start);
  if (existing) return { ...existing, created: false };

  const [platform, invoicingRule, shopWalletRule] = await Promise.all([platformInvoicingStatus(), getRule("platformInvoicing"), getRule("shopWallet")]);
  const actor = options.actor;

  const outcome = await db.transaction(async (tx) => {
    // One close at a time, taken before the first seller read: the lines already paid (payout_cycle_lines,
    // seller) are then read from a snapshot that includes any close that finished while this one waited.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('gokesari-payout-cycle-close'))`);
    const [cycle] = await tx
      .insert(payoutCycles)
      .values({ cycleStart: window.start, cycleEnd: window.end, cycleDays: rule.cycleDays, closedBy: actor.id })
      .onConflictDoNothing()
      .returning();
    if (!cycle) return null; // closed concurrently
    const warnings: string[] = [];
    if (invoicingRule.enabled && !platform.ready) {
      warnings.push(`Platform invoicing is on but GoKesari's ${platform.missing.join(", ")} is not entered: no fee invoice and no GST on fees this cycle.`);
    }
    const resolve = statutoryResolver(tx);
    const period = periodLabel(cycle);
    const endTs = startOf(window.end);

    /* ---------------------------------------------------- what is owed */
    const orderRows = await tx
      .select({ f: orderFinancials, orderNumber: orders.orderNumber })
      .from(orderFinancials)
      .innerJoin(orders, eq(orders.id, orderFinancials.orderId))
      .where(
        and(
          isNull(orderFinancials.settlementId),
          lt(orderFinancials.deliveredAt, endTs),
          lt(orderFinancials.deliveredAt, sql`now() - make_interval(days => ${rule.holdDays})`),
          inArray(orders.status, ["DELIVERED", "REFUNDED"]),
          sql`NOT EXISTS (SELECT 1 FROM ${payoutCycleLines} l WHERE l.line_type = 'GOODS' AND l.source_type = 'order_financials' AND l.source_id = ${orderFinancials.orderId}::text)`,
        ),
      )
      .for("update", { of: orderFinancials });
    const adjustments = await tx
      .select()
      .from(financialAdjustments)
      .where(
        and(
          eq(financialAdjustments.party, "SHOP"),
          eq(financialAdjustments.status, "PENDING"),
          isNull(financialAdjustments.settlementId),
          lt(financialAdjustments.createdAt, endTs),
        ),
      )
      .for("update");
    const carried = await tx
      .select()
      .from(payoutItems)
      .where(and(inArray(payoutItems.status, ["ON_HOLD", "REVERSED"]), isNull(payoutItems.carriedIntoCycleId)))
      .for("update");
    const manualNotes = await tx
      .select()
      .from(platformCreditDebitNotes)
      .where(and(isNull(platformCreditDebitNotes.appliedInCycleId), lt(platformCreditDebitNotes.issuedAt, endTs)))
      .for("update");
    const registrationFees =
      platform.ready && invoicingRule.includeRegistrationFees
        ? await tx
            .select()
            .from(shopPayments)
            .where(
              and(
                inArray(shopPayments.paymentType, ["REGISTRATION_FEE", "RENEWAL"]),
                sql`${shopPayments.amountPaise} > 0`,
                gte(shopPayments.paidAt, startOf(rule.anchorDate)),
                lt(shopPayments.paidAt, endTs),
                sql`NOT EXISTS (SELECT 1 FROM ${payoutCycleLines} l WHERE l.line_type = 'REGISTRATION_FEE' AND l.source_type = 'shop_payments' AND l.source_id = ${shopPayments.id}::text)`,
              ),
            )
        : [];

    const orderIds = orderRows.map((r) => r.f.orderId);
    const invoices = orderIds.length
      ? await tx
          .select({ orderId: taxInvoices.orderId, taxablePaise: taxInvoices.taxablePaise, totalPaise: taxInvoices.totalPaise, supplyType: taxInvoices.supplyType })
          .from(taxInvoices)
          .where(inArray(taxInvoices.orderId, orderIds))
      : [];
    const invoiceByOrder = new Map(invoices.map((i) => [i.orderId, i]));

    const shopIds = [
      ...new Set([
        ...orderRows.map((r) => r.f.shopId),
        ...adjustments.map((a) => a.shopId!).filter(Boolean),
        ...carried.map((c) => c.shopId),
        ...manualNotes.map((n) => n.shopId),
        ...registrationFees.map((p) => p.shopId),
      ]),
    ];
    const shopRows = shopIds.length ? await tx.select().from(shops).where(inArray(shops.id, shopIds)) : [];
    const shopById = new Map(shopRows.map((s) => [s.id, s]));

    /* ------------------------------------------------- lines per shop */
    const linesByShop = new Map<string, LineDraft[]>();
    const push = (line: LineDraft) => {
      const list = linesByShop.get(line.shopId) ?? [];
      list.push(line);
      linesByShop.set(line.shopId, list);
    };

    // Order lines (and what refunds need to know about each order).
    const orderFacts = new Map<string, { taxablePaise: number; goodsPaise: number; supply: "INTRA" | "INTER"; tcsRateBp: number | null; tdsRateBp: number | null; tdsBaseExcludesGst: boolean; commissionRateBp: number }>();
    const sorted = [...orderRows].sort((a, b) => a.f.deliveredAt.getTime() - b.f.deliveredAt.getTime());
    const fyGross = new Map<string, number>(); // shopId|FY → gross delivered before the running order
    for (const { f, orderNumber } of sorted) {
      const shop = shopById.get(f.shopId);
      if (!shop) continue;
      const day = istDay(f.deliveredAt);
      const base = { shopId: f.shopId, sourceType: "order_financials", sourceId: f.orderId, occurredOn: day };
      push({ ...base, lineType: "GOODS", description: `Order ${orderNumber}`, amountPaise: f.goodsPaise, basePaise: f.goodsPaise, meta: { orderNumber } });
      const viaWallet = f.commissionCollection === "SHOP_WALLET";
      push({
        ...base,
        lineType: "COMMISSION",
        description: `Commission ${(f.commissionRateBp / 100).toFixed(2)}% on order ${orderNumber}${viaWallet ? " (paid from shop wallet)" : ""}`,
        amountPaise: viaWallet ? 0 : -(f.goodsPaise - f.shopPayablePaise),
        basePaise: f.goodsPaise,
        rateBp: f.commissionRateBp,
        meta: { orderNumber, commissionPaise: f.commissionPaise, collectedVia: viaWallet ? "SHOP_WALLET" : "PAYOUT" },
      });
      if (f.shopDeliveryChargePaise > 0) {
        push({
          ...base,
          lineType: "DELIVERY_CHARGE",
          description: `Delivery charge on order ${orderNumber} (paid from shop wallet)`,
          amountPaise: 0,
          basePaise: f.shopDeliveryChargePaise,
          meta: { orderNumber, chargePaise: f.shopDeliveryChargePaise, collectedVia: "SHOP_WALLET" },
        });
      }

      const invoice = invoiceByOrder.get(f.orderId);
      const taxable = invoice?.taxablePaise ?? f.goodsPaise;
      const supply = invoice?.supplyType ?? "INTRA";
      const registered = isGstRegistered(shop);
      const unregRules = await unregisteredRulesOn(day, resolve);
      const facts = { taxablePaise: taxable, goodsPaise: f.goodsPaise, supply, tcsRateBp: null as number | null, tdsRateBp: null as number | null, tdsBaseExcludesGst: true, commissionRateBp: f.commissionRateBp };

      const s95 = await sec95RestaurantOn(day, shop.shopType, resolve);
      if (s95) {
        push({ ...base, lineType: "SEC95_GST", description: `s.9(5): GoKesari pays GST on restaurant service, order ${orderNumber}`, amountPaise: 0, basePaise: taxable, rateBp: s95.rateBp, meta: { liabilityPaise: pctOf(taxable, s95.rateBp), statutoryRowId: s95.rowId } });
      } else {
        const tcs = await tcsOn(day, resolve);
        if (tcs && (registered || tcs.applyToUnregistered || unregRules.tcsOnUnregistered)) {
          const amount = pctOf(taxable, tcs.rateBp);
          facts.tcsRateBp = tcs.rateBp;
          push({
            ...base,
            lineType: "TCS",
            description: `GST TCS s.52 ${(tcs.rateBp / 100).toFixed(2)}% on order ${orderNumber}`,
            amountPaise: -amount,
            basePaise: taxable,
            rateBp: tcs.rateBp,
            meta: { orderNumber, supply, ...splitTax(amount, supply), statutoryRowId: tcs.rowId, taxableFrom: invoice ? "TAX_INVOICE" : "GOODS_VALUE" },
          });
        }
      }

      const tds = await tdsOn(day, resolve);
      if (tds && (registered || unregRules.tdsOnUnregistered)) {
        const pan = shopPan(shop);
        const tdsBase = tds.baseExcludesGst ? taxable : f.goodsPaise;
        let rateBp = pan ? tds.rateBp : tds.noPanRateBp;
        let exempt = false;
        // Individual / HUF with PAN: exempt while the FY's gross sales stay within the limit.
        if (pan && /^[A-Z]{3}[PH]/.test(pan) && tds.exemptIndividualHufUpToPaise > 0) {
          const fy = financialYearOf(f.deliveredAt);
          const key = `${shop.id}|${fy}`;
          if (!fyGross.has(key)) {
            const fyStart = `${fy.slice(0, 4)}-04-01`;
            const [row] = await tx
              .select({ gross: sql<number>`coalesce(sum(${orderFinancials.goodsPaise}), 0)::bigint` })
              .from(orderFinancials)
              .where(and(eq(orderFinancials.shopId, shop.id), gte(orderFinancials.deliveredAt, startOf(fyStart)), lt(orderFinancials.deliveredAt, f.deliveredAt)));
            fyGross.set(key, Number(row?.gross ?? 0));
          }
          const running = fyGross.get(key)! + f.goodsPaise;
          fyGross.set(key, running);
          if (running <= tds.exemptIndividualHufUpToPaise) {
            exempt = true;
            rateBp = 0;
          }
        }
        facts.tdsRateBp = rateBp;
        facts.tdsBaseExcludesGst = tds.baseExcludesGst;
        push({
          ...base,
          lineType: "TDS",
          description: exempt
            ? `TDS ${tds.sectionLabel}: exempt (individual/HUF within the yearly limit), order ${orderNumber}`
            : `TDS ${tds.sectionLabel} ${(rateBp / 100).toFixed(2)}%${pan ? "" : " (no PAN)"} on order ${orderNumber}`,
          amountPaise: -pctOf(tdsBase, rateBp),
          basePaise: tdsBase,
          rateBp,
          meta: { orderNumber, section: tds.sectionLabel, panAvailable: Boolean(pan), exempt, statutoryRowId: tds.rowId },
        });
      }
      orderFacts.set(f.orderId, facts);
    }

    // What earlier cycles recorded for orders refunded now.
    const refundOrderIds = [...new Set(adjustments.filter((a) => a.type === "REFUND_SHOP" && a.orderId && !orderFacts.has(a.orderId)).map((a) => a.orderId!))];
    if (refundOrderIds.length) {
      const earlier = await tx
        .select()
        .from(payoutCycleLines)
        .where(and(eq(payoutCycleLines.sourceType, "order_financials"), inArray(payoutCycleLines.sourceId, refundOrderIds)));
      for (const orderId of refundOrderIds) {
        const mine = earlier.filter((l) => l.sourceId === orderId);
        const goods = mine.find((l) => l.lineType === "GOODS");
        if (!goods) continue;
        const tcs = mine.find((l) => l.lineType === "TCS");
        const tds = mine.find((l) => l.lineType === "TDS");
        const commission = mine.find((l) => l.lineType === "COMMISSION");
        orderFacts.set(orderId, {
          taxablePaise: tcs?.basePaise ?? goods.basePaise ?? goods.amountPaise,
          goodsPaise: goods.amountPaise,
          supply: ((tcs?.meta as { supply?: "INTRA" | "INTER" } | undefined)?.supply ?? "INTRA"),
          tcsRateBp: tcs?.rateBp ?? null,
          tdsRateBp: tds?.rateBp ?? null,
          tdsBaseExcludesGst: tds ? tds.basePaise !== goods.amountPaise : true,
          commissionRateBp: commission?.rateBp ?? 0,
        });
      }
    }
    const refundNotes = adjustments.length
      ? await tx
          .select({ sourceRef: creditNotes.sourceRef, taxablePaise: creditNotes.taxablePaise })
          .from(creditNotes)
          .where(inArray(creditNotes.sourceRef, adjustments.map((a) => a.id)))
      : [];
    const refundTaxable = new Map(refundNotes.map((n) => [n.sourceRef, n.taxablePaise]));

    for (const a of adjustments) {
      if (!a.shopId || !shopById.has(a.shopId)) continue;
      const day = istDay(a.createdAt);
      const base = { shopId: a.shopId, sourceType: "financial_adjustments", sourceId: a.id, occurredOn: day };
      if (a.type !== "REFUND_SHOP") {
        push({ ...base, lineType: "ADJUSTMENT", description: `Adjustment: ${a.reason}`, amountPaise: a.amountPaise, meta: { type: a.type } });
        continue;
      }
      push({ ...base, lineType: "REFUND", description: `Refund to customer: ${a.reason}`, amountPaise: a.amountPaise, meta: { orderId: a.orderId, customerRefundPaise: a.customerRefundPaise } });
      const facts = a.orderId ? orderFacts.get(a.orderId) : undefined;
      if (!facts) continue;
      const refundGoods = Math.min(a.customerRefundPaise ?? 0, facts.goodsPaise);
      const returnedTaxable = refundTaxable.get(a.id) ?? (facts.goodsPaise > 0 ? Math.round((refundGoods * facts.taxablePaise) / facts.goodsPaise) : 0);
      if (facts.tcsRateBp && returnedTaxable > 0) {
        const amount = pctOf(returnedTaxable, facts.tcsRateBp);
        push({ ...base, lineType: "TCS", description: `GST TCS reversed on a return (${a.reason})`, amountPaise: amount, basePaise: -returnedTaxable, rateBp: facts.tcsRateBp, meta: { orderId: a.orderId, supply: facts.supply, ...splitTax(-amount, facts.supply) } });
      }
      if (facts.tdsRateBp && refundGoods > 0) {
        const tdsBase = facts.tdsBaseExcludesGst ? returnedTaxable : refundGoods;
        push({ ...base, lineType: "TDS", description: `TDS reversed on a refund (${a.reason})`, amountPaise: pctOf(tdsBase, facts.tdsRateBp), basePaise: -tdsBase, rateBp: facts.tdsRateBp, meta: { orderId: a.orderId } });
      }
    }

    for (const c of carried) {
      push({
        shopId: c.shopId,
        lineType: "CARRY_FORWARD",
        sourceType: "payout_items",
        sourceId: c.id,
        description: c.status === "REVERSED" ? "Payout returned by the bank, paid again" : `Held payout carried forward (${c.holdReason ?? "held"})`,
        amountPaise: c.amountPaise,
        occurredOn: istDay(c.createdAt),
        meta: { fromCycleId: c.cycleId, status: c.status },
      });
    }
    for (const n of manualNotes) {
      push({
        shopId: n.shopId,
        lineType: "PLATFORM_NOTE",
        sourceType: "platform_credit_debit_notes",
        sourceId: n.id,
        description: `${n.kind === "CREDIT" ? "Credit" : "Debit"} note ${n.noteNumber}: ${n.reason}`,
        amountPaise: n.kind === "CREDIT" ? n.totalPaise : -n.totalPaise,
        occurredOn: istDay(n.issuedAt),
        meta: { noteNumber: n.noteNumber },
      });
    }

    /* ------------------------- GoKesari's invoice for its fees (F10.2.5) */
    const issuedInvoices: { shopId: string; invoiceId: string; invoiceNumber: string; totalPaise: number; ownerId: string }[] = [];
    if (platform.ready) {
      for (const shopId of shopIds) {
        const shop = shopById.get(shopId)!;
        const mine = linesByShop.get(shopId) ?? [];
        const commission = (via: string) =>
          mine.filter((l) => l.lineType === "COMMISSION" && (l.meta?.collectedVia as string) === via).reduce((s, l) => s + Number(l.meta?.commissionPaise ?? 0), 0);
        const fees: FeeInput[] = [
          { feeType: "COMMISSION", description: "Marketplace commission (withheld from payout)", amountPaise: commission("PAYOUT"), inclusive: false, collectedVia: "PAYOUT" },
          { feeType: "COMMISSION", description: "Marketplace commission (debited from shop wallet)", amountPaise: commission("SHOP_WALLET"), inclusive: false, collectedVia: "SHOP_WALLET" },
          {
            feeType: "DELIVERY_CHARGE",
            amountPaise: mine.filter((l) => l.lineType === "DELIVERY_CHARGE").reduce((s, l) => s + Number(l.meta?.chargePaise ?? 0), 0),
            inclusive: false,
            collectedVia: "SHOP_WALLET",
          },
          ...registrationFees
            .filter((p) => p.shopId === shopId)
            .map((p) => ({ feeType: "REGISTRATION_FEE" as const, description: `Shop registration fee (receipt ${p.reference}, already paid)`, amountPaise: p.amountPaise, inclusive: true, collectedVia: "PAID_DIRECTLY" as const })),
        ];
        const hasActivity = mine.some((l) => l.lineType === "GOODS") || registrationFees.some((p) => p.shopId === shopId);
        if (invoicingRule.billingManagementFeePaise > 0 && hasActivity) {
          fees.push({ feeType: "BILLING_MANAGEMENT", amountPaise: invoicingRule.billingManagementFeePaise, inclusive: false, collectedVia: "PAYOUT" });
          push({
            shopId,
            lineType: "PLATFORM_FEE",
            sourceType: "billing_management",
            sourceId: `${cycle.id}:${shopId}`,
            description: "Inventory and billing management charge",
            amountPaise: -invoicingRule.billingManagementFeePaise,
            occurredOn: addDays(window.end, -1),
          });
        }
        for (const p of registrationFees.filter((r) => r.shopId === shopId)) {
          push({ shopId, lineType: "REGISTRATION_FEE", sourceType: "shop_payments", sourceId: p.id, description: `Registration fee ${p.reference} (already paid; on GoKesari's invoice)`, amountPaise: 0, basePaise: p.amountPaise, occurredOn: istDay(p.paidAt) });
        }
        const invoice = await issuePlatformInvoice({ shop, cycleId: cycle.id, period, fees }, tx);
        if (!invoice) continue;
        issuedInvoices.push({ shopId, invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, totalPaise: invoice.totalPaise, ownerId: shop.ownerId });
        if (invoice.gstDeductedPaise > 0) {
          push({
            shopId,
            lineType: "FEE_GST",
            sourceType: "platform_invoices",
            sourceId: invoice.id,
            description: `GST on GoKesari's fees (invoice ${invoice.invoiceNumber})`,
            amountPaise: -invoice.gstDeductedPaise,
            basePaise: invoice.taxablePaise,
            occurredOn: istDay(invoice.issuedAt),
            meta: { invoiceNumber: invoice.invoiceNumber, cgst: invoice.cgstPaise, sgst: invoice.sgstPaise, igst: invoice.igstPaise },
          });
        }
      }
      // Commission given back on refunded goods → a credit note against the invoice that billed it.
      for (const a of adjustments.filter((x) => x.type === "REFUND_SHOP" && x.orderId && x.shopId)) {
        const facts = orderFacts.get(a.orderId!);
        if (!facts) continue;
        const billedIn = orderIds.includes(a.orderId!) ? cycle.id : null;
        const credited = await creditCommissionOnRefund(a, cycle.id, billedIn, facts, tx).catch((error: unknown) => {
          // Split layout: the close is run again from the start; swallowing it would settle the refund without its note.
          if (isRetryableTransactionError(error)) throw error;
          warnings.push(`No fee credit note for refund ${a.id}: ${error instanceof Error ? error.message : "error"}`);
          return null;
        });
        if (credited) {
          push({
            shopId: a.shopId!,
            lineType: "FEE_GST",
            sourceType: "platform_credit_debit_notes",
            sourceId: credited.id,
            description: `GST on commission credited back (credit note ${credited.noteNumber})`,
            amountPaise: credited.cgstPaise + credited.sgstPaise + credited.igstPaise,
            basePaise: -credited.taxablePaise,
            occurredOn: istDay(credited.issuedAt),
            meta: { noteNumber: credited.noteNumber },
          });
        }
      }
    }

    /* ----------------------------------------------------- items + batch */
    const accounts = shopIds.length
      ? await tx
          .select({ id: bankAccounts.id, shopId: bankAccounts.shopId, status: bankAccounts.status })
          .from(bankAccounts)
          .where(and(inArray(bankAccounts.shopId, shopIds), eq(bankAccounts.isCurrent, true)))
      : [];
    const accountByShop = new Map(accounts.map((a) => [a.shopId!, a]));

    const itemDrafts: { shopId: string; amountPaise: number; breakdown: Record<string, number>; bankAccountId: string | null; holdReason: string | null }[] = [];
    for (const shopId of shopIds) {
      const mine = linesByShop.get(shopId) ?? [];
      let net = mine.reduce((s, l) => s + l.amountPaise, 0);
      const moving = mine.some((l) => l.amountPaise !== 0);
      if (!moving) continue;
      const account = accountByShop.get(shopId);
      let holdReason: string | null = null;
      if (net <= 0) holdReason = "NOT_POSITIVE";
      else if (account?.status !== "VERIFIED") holdReason = "BANK_NOT_VERIFIED";
      else if (net < rule.minPayoutPaise) holdReason = "BELOW_MINIMUM";
      if (!holdReason && rule.walletTopUpTargetPaise > 0 && shopWalletRule.enabled) {
        const balance = await getShopWalletBalance(shopId, tx);
        const topUp = Math.min(Math.max(0, rule.walletTopUpTargetPaise - balance), net - rule.minPayoutPaise);
        if (topUp > 0) {
          const line: LineDraft = {
            shopId,
            lineType: "WALLET_TOPUP",
            sourceType: "payout_topup",
            sourceId: `${cycle.id}:${shopId}`,
            description: `Shop wallet top-up from payout (balance ${formatPaise(balance)}, target ${formatPaise(rule.walletTopUpTargetPaise)})`,
            amountPaise: -topUp,
            occurredOn: addDays(window.end, -1),
            meta: { balanceBefore: balance },
          };
          mine.push(line);
          net -= topUp;
        }
      }
      const breakdown: Record<string, number> = {};
      for (const l of mine) breakdown[l.lineType] = (breakdown[l.lineType] ?? 0) + l.amountPaise;
      itemDrafts.push({ shopId, amountPaise: net, breakdown, bankAccountId: account?.id ?? null, holdReason });
    }

    const allLines = [...linesByShop.values()].flat();
    if (allLines.length) {
      for (let i = 0; i < allLines.length; i += 500) {
        await tx.insert(payoutCycleLines).values(
          allLines.slice(i, i + 500).map((l) => ({
            cycleId: cycle.id,
            shopId: l.shopId,
            lineType: l.lineType,
            sourceType: l.sourceType,
            sourceId: l.sourceId,
            description: l.description.slice(0, 300),
            amountPaise: l.amountPaise,
            basePaise: l.basePaise ?? null,
            rateBp: l.rateBp ?? null,
            occurredOn: l.occurredOn,
            meta: l.meta ?? {},
          })),
        );
      }
    }
    if (adjustments.length) {
      await tx.update(financialAdjustments).set({ status: "SETTLED" }).where(inArray(financialAdjustments.id, adjustments.filter((a) => a.shopId && shopById.has(a.shopId)).map((a) => a.id)));
    }
    if (carried.length) {
      await tx
        .update(payoutItems)
        .set({ status: "CARRIED_FORWARD", carriedIntoCycleId: cycle.id, updatedAt: new Date() })
        .where(inArray(payoutItems.id, carried.map((c) => c.id)));
    }
    if (manualNotes.length) {
      await tx.update(platformCreditDebitNotes).set({ appliedInCycleId: cycle.id }).where(inArray(platformCreditDebitNotes.id, manualNotes.map((n) => n.id)));
    }

    let batch: PayoutBatch | null = null;
    let items: PayoutItem[] = [];
    if (itemDrafts.length) {
      const payable = itemDrafts.filter((d) => !d.holdReason);
      [batch] = await tx
        .insert(payoutBatches)
        .values({
          cycleId: cycle.id,
          itemCount: payable.length,
          totalPaise: payable.reduce((s, d) => s + d.amountPaise, 0),
          createdBy: actor.id,
        })
        .returning();
      items = await tx
        .insert(payoutItems)
        .values(
          itemDrafts.map((d) => ({
            batchId: batch!.id,
            cycleId: cycle.id,
            shopId: d.shopId,
            bankAccountId: d.bankAccountId,
            amountPaise: d.amountPaise,
            breakdown: d.breakdown,
            status: d.holdReason ? ("ON_HOLD" as const) : ("PENDING" as const),
            holdReason: d.holdReason,
            idempotencyKey: `payout-item:${cycle.id}:${d.shopId}`,
          })),
        )
        .returning();
      await tx.insert(payoutEvents).values({ batchId: batch.id, source: "SYSTEM", eventId: `batch-drafted:${batch.id}`, type: "BATCH_DRAFTED", payload: { items: items.length, payable: payable.length }, actorId: actor.id });
      await emitEvent(
        {
          type: "payout.batch_drafted",
          subjectId: batch.id,
          actor,
          payload: { batchId: batch.id, period, items: payable.length, amount: formatPaise(batch.totalPaise), held: items.length - payable.length },
          idempotencyKey: `payout-batch-drafted:${batch.id}`,
        },
        tx,
      );
      for (const item of items.filter((i) => i.status === "ON_HOLD")) {
        const shop = shopById.get(item.shopId)!;
        await emitEvent(
          {
            type: "payout.item_held",
            subjectId: item.id,
            actor,
            payload: { itemId: item.id, ownerId: shop.ownerId, shopName: shop.name, amount: formatPaise(item.amountPaise), period, reason: HOLD_REASONS[item.holdReason ?? ""] ?? "held." },
            idempotencyKey: `payout-item-held:${item.id}`,
          },
          tx,
        );
      }
    }
    for (const inv of issuedInvoices) {
      await emitEvent(
        {
          type: "platform_invoice.issued",
          subjectId: inv.invoiceId,
          actor,
          payload: { invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, ownerId: inv.ownerId, amount: formatPaise(inv.totalPaise), period },
          idempotencyKey: `platform-invoice-issued:${inv.invoiceId}`,
        },
        tx,
      );
      await queueDocumentEmail(
        {
          docType: "PLATFORM_INVOICE",
          docId: inv.invoiceId,
          userId: inv.ownerId,
          recipientRole: "SHOP_OWNER",
          title: `GoKesari invoice ${inv.invoiceNumber}`,
          body: `GoKesari's tax invoice ${inv.invoiceNumber} for its fees for ${period} (${formatPaise(inv.totalPaise)} incl. GST) is attached.`,
          actionUrl: "/shop/finance#statements",
          category: "SHOP",
        },
        tx,
      );
    }

    const [updated] = await tx
      .update(payoutCycles)
      .set({
        status: batch ? "BATCHED" : "CLOSED",
        shopCount: itemDrafts.length,
        netPayablePaise: itemDrafts.filter((d) => !d.holdReason).reduce((s, d) => s + d.amountPaise, 0),
        warnings,
      })
      .where(eq(payoutCycles.id, cycle.id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PAYOUT_CYCLE_CLOSED,
        entityType: "payout_cycle",
        entityId: cycle.id,
        newValue: { cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd, shops: itemDrafts.length, batchId: batch?.id ?? null, netPayablePaise: updated.netPayablePaise, warnings },
      },
      tx,
    );
    return { cycle: updated, batch, items, created: true };
  });
  if (!outcome) {
    const raced = await loadCycle(window.start);
    return raced ? { ...raced, created: false } : null;
  }
  return outcome;
}

export const HOLD_REASONS: Record<string, string> = {
  BANK_NOT_VERIFIED: "the shop has no verified bank account yet — add and verify one under Payout bank.",
  BELOW_MINIMUM: "the amount is below the minimum payout.",
  NOT_POSITIVE: "deductions and refunds are more than the sales this cycle; the balance is carried into the next cycle.",
  RELEASED_TO_NEXT_CYCLE: "finance moved it to the next payout cycle.",
};

async function loadCycle(cycleStart: IsoDate): Promise<Omit<CloseCycleResult, "created"> | null> {
  const [cycle] = await db.select().from(payoutCycles).where(eq(payoutCycles.cycleStart, cycleStart));
  if (!cycle) return null;
  const [batch] = await db.select().from(payoutBatches).where(and(eq(payoutBatches.cycleId, cycle.id), sql`${payoutBatches.status} <> 'CANCELLED'`));
  const items = batch ? await db.select().from(payoutItems).where(eq(payoutItems.batchId, batch.id)) : [];
  return { cycle, batch: batch ?? null, items };
}

/**
 * The commission on refunded goods is given back to the shop (finance.ts),
 * so GoKesari's fee invoice that billed it gets a credit note — under a
 * savepoint, so a refusal (e.g. it would take the invoice below zero) only
 * skips the note.
 */
async function creditCommissionOnRefund(
  a: FinancialAdjustment,
  cycleId: string,
  billedInCycleId: string | null,
  facts: { goodsPaise: number; commissionRateBp: number },
  tx: DbClient,
) {
  const refundGoods = Math.min(a.customerRefundPaise ?? 0, facts.goodsPaise);
  const commissionBack = commissionOn(refundGoods, facts.commissionRateBp);
  if (commissionBack <= 0) return null;
  // The invoice of the cycle in which the order's commission was billed (this one, or an earlier one).
  let billedIn = billedInCycleId;
  if (!billedIn) {
    const [line] = await tx
      .select({ cycleId: payoutCycleLines.cycleId })
      .from(payoutCycleLines)
      .where(and(eq(payoutCycleLines.lineType, "COMMISSION"), eq(payoutCycleLines.sourceType, "order_financials"), eq(payoutCycleLines.sourceId, a.orderId!)));
    billedIn = line?.cycleId ?? null;
  }
  if (!billedIn) return null;
  const [invoice] = await tx.select({ id: platformInvoices.id }).from(platformInvoices).where(and(eq(platformInvoices.shopId, a.shopId!), eq(platformInvoices.cycleId, billedIn)));
  if (!invoice) return null;
  return tx.transaction((sp) =>
    issuePlatformNote(
      { invoiceId: invoice.id, kind: "CREDIT", reason: `Commission on refunded goods (${a.reason})`, sourceRef: `refund:${a.id}`, lines: [{ feeType: "COMMISSION", taxablePaise: commissionBack }], appliedInCycleId: cycleId },
      sp,
    ),
  );
}

