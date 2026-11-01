/**
 * Billing v2 money-flow record (docs/billing §5.1, gaps G1/G2): written once
 * per delivered order, next to its order_financials row and in the same
 * transaction (services/finance.ts recordOrderFinancials). Nothing happens
 * while the billing_v2 flag is off.
 *
 * Reads what the order already records — payment method, fulfilment
 * arrangement, the rider who delivered it — and the rules for the day of
 * delivery (rule billing, statutory_rates), and asks the tax engine:
 * who received the money, is TCS / TDS in scope, who owes GST on the
 * delivery fee — and, for a restaurant covered by the dated row
 * GST_S95_RESTAURANT, that GoKesari owes the GST on the food (§5.3: GoKesari
 * invoices it and no TCS is collected). Later rule changes never rewrite a
 * recorded order.
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import { gstState } from "@/lib/gst-states";
import { formatQuantity } from "@/lib/money";
import { db, isSerializationFailure, type DbClient } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  deliveryPartners,
  orderFulfilmentArrangements,
  orderItems,
  orderMoneyFlows,
  orders,
  payoutCycleLines,
  payoutItems,
  platformDeliveryInvoices,
  shops,
  statutoryRates,
  type OrderMoneyFlow,
} from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { istDay, sec95RestaurantOn, statutoryResolver, tcsOn, tdsOn, unregisteredRulesOn } from "@/server/statutory/rates";
import { placeOfSupplyOf } from "./checkout";
import { issueDeliveryFeeInvoice, issueRestaurantS95Invoice, type FoodGstLine } from "./delivery-invoice";
import { splitInclusiveWithCess } from "./split";
import { deliveryFeeGst, effectiveRegistrationType, moneyCollector, moneyFlowMode, supplyTypeOf, tcsFor, tdsApplies, type Fulfilment } from "./engine";

export async function recordOrderMoneyFlow(orderId: string, client: DbClient = db, at: Date = new Date()): Promise<OrderMoneyFlow | null> {
  if (!(await isFeatureEnabled("billing_v2"))) return null;
  const [order] = await client.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [shopRow] = await client
    .select({ gstRegistrationType: shops.gstRegistrationType, gstStatus: shops.gstStatus, gstin: shops.gstin, shopType: shops.shopType, name: shops.name, legalName: shops.legalBusinessName })
    .from(shops)
    .where(eq(shops.id, order.shopId));
  if (!shopRow) return null;
  const shop = { registrationType: effectiveRegistrationType(shopRow) };

  const [arrangement] = await client
    .select({ option: orderFulfilmentArrangements.option })
    .from(orderFulfilmentArrangements)
    .where(eq(orderFulfilmentArrangements.orderId, orderId));
  // No arrangement: the order went through the GoKesari partner dispatch (the default).
  const fulfilment: Fulfilment = arrangement?.option ?? (order.addressId || order.deliveryAddressSnapshot ? "GOKESARI_PARTNER" : "PICKUP");

  const rule = await getRule("billing");
  const mode = moneyFlowMode(order.paymentMethod, fulfilment);
  const collector = moneyCollector(mode, rule.collectorByMode);
  const day = istDay(at);
  const resolve = statutoryResolver(client);
  const unreg = await unregisteredRulesOn(day, resolve);
  const tcs = await tcsOn(day, resolve);
  const tds = await tdsOn(day, resolve);
  // §5.3: a restaurant's food on which GoKesari pays GST under s.9(5) — GoKesari is the deemed supplier.
  const food = await sec95RestaurantOn(day, shopRow.shopType, resolve);

  const tcsDecision = tcsFor({
    supplier: shop.registrationType,
    collector,
    netTaxablePaise: order.subtotalPaise,
    supply: "INTRA",
    deemedSupplier: food != null,
    rules: { rateBp: tcs?.rateBp ?? null, applyWhenShopCollects: rule.tcsWhenShopCollects, tcsOnUnregistered: tcs?.applyToUnregistered === true || unreg.tcsOnUnregistered },
  });
  const tdsInScope = tdsApplies({
    supplier: shop.registrationType,
    collector,
    rules: { inForce: tds != null, whenShopCollects: rule.tdsWhenShopCollects, onUnregistered: unreg.tdsOnUnregistered },
  });

  // Delivery fee: the rider who delivered it, GoKesari's state vs. the delivery address's.
  let riderGstRegistered = false;
  if (fulfilment === "GOKESARI_PARTNER") {
    const [rider] = await client
      .select({ gstRegistered: deliveryPartners.gstRegistered })
      .from(deliveryOrders)
      .innerJoin(deliveryPartners, eq(deliveryPartners.id, deliveryOrders.deliveryPartnerId))
      .where(and(eq(deliveryOrders.orderId, orderId), eq(deliveryOrders.status, "DELIVERED")))
      .orderBy(desc(deliveryOrders.offeredAt))
      .limit(1);
    riderGstRegistered = rider?.gstRegistered ?? false;
  }
  const address = order.addressId ? await client.query.addresses.findFirst({ where: eq(addresses.id, order.addressId) }) : undefined;
  const platformState = gstState((await getRule("platformTaxProfile")).stateCode || null)?.alpha ?? null;
  const placeOfSupply = placeOfSupplyOf(address ? { state: address.state, pincode: address.pincode } : order.deliveryAddressSnapshot ? { pincode: order.deliveryAddressSnapshot.pincode } : null);
  const supply = supplyTypeOf(platformState, placeOfSupply);
  const s95 = (await isFeatureEnabled("delivery_9_5")) ? await resolve("GST_S95_LOCAL_DELIVERY", day) : null;
  const delivery = deliveryFeeGst({
    fulfilment,
    feePaise: order.deliveryFeePaise,
    riderGstRegistered,
    supply,
    rules: { rateBp: s95?.enabled ? s95.rateBp : null, shopDeliveryIsShopSupply: rule.shopDeliveryIsShopSupply },
  });

  const foodLines = food ? await foodGstLines(orderId, food.rateBp, supply, client) : [];
  const foodGstPaise = foodLines.reduce((n, l) => n + l.cgstPaise + l.sgstPaise + l.igstPaise, 0);

  const [row] = await client
    .insert(orderMoneyFlows)
    .values({
      orderId,
      shopId: order.shopId,
      paymentMethod: order.paymentMethod,
      fulfilment,
      mode,
      collectedBy: collector,
      tcsApplicable: tcsDecision.applies,
      tdsApplicable: tdsInScope,
      deliveryGstLiable: delivery.liable,
      deliveryGstRateBp: delivery.liable === "GOKESARI_S95" ? delivery.rateBp : null,
      deliveryGstPaise: delivery.liable === "GOKESARI_S95" ? delivery.cgstPaise + delivery.sgstPaise + delivery.igstPaise : 0,
      foodGstLiable: food ? "GOKESARI_S95" : "SHOP",
      foodGstRateBp: food?.rateBp ?? null,
      foodGstPaise,
      ruleSnapshot: { billing: rule, day, registrationType: shop.registrationType, tcsRowId: tcs?.rowId ?? null, tdsRowId: tds?.rowId ?? null, s95RowId: s95?.id ?? null, s95RestaurantRowId: food?.rowId ?? null },
      recordedAt: at,
    })
    .onConflictDoNothing()
    .returning();
  if (row && delivery.liable === "GOKESARI_S95") {
    // GoKesari's own invoice for the fee (§5.2). Its own savepoint: a problem here (GoKesari's
    // GSTIN not set yet) never blocks the delivery; issueMissingDeliveryFeeInvoices catches up.
    await client
      .transaction((sp) =>
        issueDeliveryFeeInvoice(
          orderId,
          { ...delivery, withoutItc: s95?.params.withoutItc === true, supplyType: supply, placeOfSupply },
          sp,
          at,
        ),
      )
      .catch((error) => {
        if (isSerializationFailure(error)) throw error;
        console.error("[billing] delivery-fee invoice not issued for order", orderId, error);
      });
  }
  if (row && food) {
    // GoKesari's invoice for the food (§5.3), in the same way: never blocks the delivery.
    const restaurant = { name: shopRow.legalName ?? shopRow.name, gstin: shopRow.gstin && effectiveRegistrationType(shopRow) !== "UNREGISTERED" ? shopRow.gstin : null };
    await client
      .transaction((sp) => issueRestaurantS95Invoice(orderId, { rateBp: food.rateBp, withoutItc: food.withoutItc, supplyType: supply, placeOfSupply, lines: foodLines, restaurant }, sp, at))
      .catch((error) => {
        if (isSerializationFailure(error)) throw error;
        console.error("[billing] restaurant s.9(5) invoice not issued for order", orderId, error);
      });
  }
  return row ?? null;
}

/** The order's dishes as delivered, each tax-inclusive, with the s.9(5) GST taken out of it. */
export async function foodGstLines(orderId: string, rateBp: number, supply: "INTRA" | "INTER", client: DbClient = db): Promise<FoodGstLine[]> {
  const items = await client.select().from(orderItems).where(eq(orderItems.orderId, orderId));
  return items
    .filter((i) => i.fulfilmentStatus !== "REMOVED")
    .map((i) => {
      const substituted = i.fulfilmentStatus === "SUBSTITUTED" && i.substituteLineTotalPaise != null;
      const gross = substituted ? i.substituteLineTotalPaise! : i.lineTotalPaise;
      const split = splitInclusiveWithCess(gross, rateBp, 0, supply);
      return {
        description: substituted ? (i.substituteNameSnapshot ?? i.productNameSnapshot) : i.productNameSnapshot,
        quantity: formatQuantity(substituted ? (i.substituteQuantityMilli ?? i.quantityMilli) : i.quantityMilli, substituted ? (i.substituteUnitSnapshot ?? i.unitSnapshot) : i.unitSnapshot),
        grossPaise: gross,
        taxablePaise: split.taxablePaise,
        cgstPaise: split.cgstPaise,
        sgstPaise: split.sgstPaise,
        igstPaise: split.igstPaise,
      };
    });
}

/**
 * Issues the s.9(5) delivery-fee invoices that were due but not issued (GoKesari's GSTIN was
 * missing at the time, or the issue failed). Safe to run again: one invoice per order, ever.
 */
export async function issueMissingDeliveryFeeInvoices(limit = 200): Promise<{ issued: number; failed: number }> {
  const due = await db
    .select({ flow: orderMoneyFlows, address: addresses })
    .from(orderMoneyFlows)
    .innerJoin(orders, eq(orders.id, orderMoneyFlows.orderId))
    .leftJoin(addresses, eq(addresses.id, orders.addressId))
    .leftJoin(platformDeliveryInvoices, and(eq(platformDeliveryInvoices.orderId, orderMoneyFlows.orderId), eq(platformDeliveryInvoices.kind, "DELIVERY")))
    .where(and(eq(orderMoneyFlows.deliveryGstLiable, "GOKESARI_S95"), isNull(platformDeliveryInvoices.id)))
    .limit(limit);
  const platformState = gstState((await getRule("platformTaxProfile")).stateCode || null)?.alpha ?? null;
  let issued = 0;
  let failed = 0;
  for (const { flow, address } of due) {
    const [order] = await db.select().from(orders).where(eq(orders.id, flow.orderId));
    const placeOfSupply = placeOfSupplyOf(address ? { state: address.state, pincode: address.pincode } : order?.deliveryAddressSnapshot ? { pincode: order.deliveryAddressSnapshot.pincode } : null);
    const supplyType = supplyTypeOf(platformState, placeOfSupply);
    const split = splitInclusiveWithCess(order?.deliveryFeePaise ?? 0, flow.deliveryGstRateBp ?? 0, 0, supplyType);
    const withoutItc = await withoutItcOf((flow.ruleSnapshot as { s95RowId?: string | null }).s95RowId ?? null);
    try {
      await db.transaction((tx) =>
        issueDeliveryFeeInvoice(
          flow.orderId,
          {
            rateBp: flow.deliveryGstRateBp ?? 0,
            withoutItc,
            feePaise: order?.deliveryFeePaise ?? 0,
            ...split,
            supplyType,
            placeOfSupply,
          },
          tx,
          flow.recordedAt,
        ),
      );
      issued += 1;
    } catch (error) {
      failed += 1;
      console.error("[billing] delivery-fee invoice still not issued", flow.orderId, error);
    }
  }

  // Restaurant s.9(5) invoices (§5.3) due but not issued.
  const food = await db
    .select({ flow: orderMoneyFlows, address: addresses, shop: { name: shops.name, legalName: shops.legalBusinessName, gstin: shops.gstin, gstRegistrationType: shops.gstRegistrationType, gstStatus: shops.gstStatus } })
    .from(orderMoneyFlows)
    .innerJoin(orders, eq(orders.id, orderMoneyFlows.orderId))
    .innerJoin(shops, eq(shops.id, orderMoneyFlows.shopId))
    .leftJoin(addresses, eq(addresses.id, orders.addressId))
    .leftJoin(platformDeliveryInvoices, and(eq(platformDeliveryInvoices.orderId, orderMoneyFlows.orderId), eq(platformDeliveryInvoices.kind, "RESTAURANT")))
    .where(and(eq(orderMoneyFlows.foodGstLiable, "GOKESARI_S95"), isNull(platformDeliveryInvoices.id)))
    .limit(limit);
  for (const { flow, address, shop } of food) {
    const [order] = await db.select().from(orders).where(eq(orders.id, flow.orderId));
    const placeOfSupply = placeOfSupplyOf(address ? { state: address.state, pincode: address.pincode } : order?.deliveryAddressSnapshot ? { pincode: order.deliveryAddressSnapshot.pincode } : null);
    const supplyType = supplyTypeOf(platformState, placeOfSupply);
    const withoutItc = await withoutItcOf((flow.ruleSnapshot as { s95RestaurantRowId?: string | null }).s95RestaurantRowId ?? null, true);
    try {
      await db.transaction(async (tx) =>
        issueRestaurantS95Invoice(
          flow.orderId,
          {
            rateBp: flow.foodGstRateBp ?? 0,
            withoutItc,
            supplyType,
            placeOfSupply,
            lines: await foodGstLines(flow.orderId, flow.foodGstRateBp ?? 0, supplyType, tx),
            restaurant: { name: shop.legalName ?? shop.name, gstin: shop.gstin && effectiveRegistrationType(shop) !== "UNREGISTERED" ? shop.gstin : null },
          },
          tx,
          flow.recordedAt,
        ),
      );
      issued += 1;
    } catch (error) {
      failed += 1;
      console.error("[billing] restaurant s.9(5) invoice still not issued", flow.orderId, error);
    }
  }
  return { issued, failed };
}

/** Whether the s.9(5) row the order was recorded under was notified "without ITC" (restaurant rows: unless said otherwise). */
async function withoutItcOf(rowId: string | null, byDefault = false): Promise<boolean> {
  if (!rowId) return byDefault;
  const [row] = await db.select({ params: statutoryRates.params }).from(statutoryRates).where(eq(statutoryRates.id, rowId));
  const flag = row?.params.withoutItc;
  return typeof flag === "boolean" ? flag : byDefault;
}

/**
 * Settlement status (§5.1): an order's money-flow record turns SETTLED once the shop payout
 * that carries the order (its GOODS line) is paid. Payout rows are seller-side and the record
 * core-side, so this reads one and writes the other — no cross-database SQL. Daily.
 */
export async function syncMoneyFlowSettlement(batch = 500): Promise<{ settled: number }> {
  let settled = 0;
  let after = "";
  for (;;) {
    const open = await db
      .select({ orderId: orderMoneyFlows.orderId })
      .from(orderMoneyFlows)
      .where(and(eq(orderMoneyFlows.settlementStatus, "UNSETTLED"), sql`${orderMoneyFlows.orderId}::text > ${after}`))
      .orderBy(sql`${orderMoneyFlows.orderId}::text`)
      .limit(batch);
    if (!open.length) break;
    after = open[open.length - 1].orderId;
    const paid = await db
      .selectDistinct({ orderId: payoutCycleLines.sourceId })
      .from(payoutCycleLines)
      .innerJoin(payoutItems, and(eq(payoutItems.cycleId, payoutCycleLines.cycleId), eq(payoutItems.shopId, payoutCycleLines.shopId)))
      .where(
        and(
          eq(payoutCycleLines.lineType, "GOODS"),
          eq(payoutCycleLines.sourceType, "order_financials"),
          inArray(
            payoutCycleLines.sourceId,
            open.map((o) => o.orderId),
          ),
          eq(payoutItems.status, "PAID"),
        ),
      );
    if (paid.length) {
      const rows = await db
        .update(orderMoneyFlows)
        .set({ settlementStatus: "SETTLED" })
        .where(and(inArray(orderMoneyFlows.orderId, paid.map((p) => p.orderId)), eq(orderMoneyFlows.settlementStatus, "UNSETTLED")))
        .returning({ orderId: orderMoneyFlows.orderId });
      settled += rows.length;
    }
    if (open.length < batch) break;
  }
  return { settled };
}

export interface MoneyFlowSummaryRow {
  mode: OrderMoneyFlow["mode"];
  collectedBy: OrderMoneyFlow["collectedBy"];
  orders: number;
  tcsApplicable: number;
  tdsApplicable: number;
  deliveryGstPaise: number;
  foodGstPaise: number;
  settled: number;
}

/** Admin (§5.1): the month's delivered orders by money-flow mode and who received the money. */
export async function moneyFlowSummary(from: Date, to: Date): Promise<MoneyFlowSummaryRow[]> {
  const rows = await db
    .select({
      mode: orderMoneyFlows.mode,
      collectedBy: orderMoneyFlows.collectedBy,
      orders: sql<number>`count(*)::int`,
      tcsApplicable: sql<number>`count(*) filter (where ${orderMoneyFlows.tcsApplicable})::int`,
      tdsApplicable: sql<number>`count(*) filter (where ${orderMoneyFlows.tdsApplicable})::int`,
      deliveryGstPaise: sql<number>`coalesce(sum(${orderMoneyFlows.deliveryGstPaise}), 0)::bigint`,
      foodGstPaise: sql<number>`coalesce(sum(${orderMoneyFlows.foodGstPaise}), 0)::bigint`,
      settled: sql<number>`count(*) filter (where ${orderMoneyFlows.settlementStatus} = 'SETTLED')::int`,
    })
    .from(orderMoneyFlows)
    .where(and(gte(orderMoneyFlows.recordedAt, from), lt(orderMoneyFlows.recordedAt, to)))
    .groupBy(orderMoneyFlows.mode, orderMoneyFlows.collectedBy)
    .orderBy(orderMoneyFlows.mode, orderMoneyFlows.collectedBy);
  return rows.map((r) => ({ ...r, deliveryGstPaise: Number(r.deliveryGstPaise), foodGstPaise: Number(r.foodGstPaise) }));
}
