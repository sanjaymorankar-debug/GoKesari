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
 * delivery fee. Later rule changes never rewrite a recorded order.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { gstState } from "@/lib/gst-states";
import { db, isSerializationFailure, type DbClient } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  deliveryPartners,
  orderFulfilmentArrangements,
  orderMoneyFlows,
  orders,
  platformDeliveryInvoices,
  shops,
  statutoryRates,
  type OrderMoneyFlow,
} from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { istDay, statutoryResolver, tcsOn, tdsOn, unregisteredRulesOn } from "@/server/statutory/rates";
import { placeOfSupplyOf } from "./checkout";
import { issueDeliveryFeeInvoice } from "./delivery-invoice";
import { splitInclusiveWithCess } from "./split";
import { deliveryFeeGst, effectiveRegistrationType, moneyCollector, moneyFlowMode, supplyTypeOf, tcsFor, tdsApplies, type Fulfilment } from "./engine";

export async function recordOrderMoneyFlow(orderId: string, client: DbClient = db, at: Date = new Date()): Promise<OrderMoneyFlow | null> {
  if (!(await isFeatureEnabled("billing_v2"))) return null;
  const [order] = await client.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return null;
  const [shopRow] = await client
    .select({ gstRegistrationType: shops.gstRegistrationType, gstStatus: shops.gstStatus, gstin: shops.gstin })
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

  const tcsDecision = tcsFor({
    supplier: shop.registrationType,
    collector,
    netTaxablePaise: order.subtotalPaise,
    supply: "INTRA",
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
      ruleSnapshot: { billing: rule, day, registrationType: shop.registrationType, tcsRowId: tcs?.rowId ?? null, tdsRowId: tds?.rowId ?? null, s95RowId: s95?.id ?? null },
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
  return row ?? null;
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
    .leftJoin(platformDeliveryInvoices, eq(platformDeliveryInvoices.orderId, orderMoneyFlows.orderId))
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
  return { issued, failed };
}

/** Whether the s.9(5) row the order was recorded under was notified "without ITC". */
async function withoutItcOf(rowId: string | null): Promise<boolean> {
  if (!rowId) return false;
  const [row] = await db.select({ params: statutoryRates.params }).from(statutoryRates).where(eq(statutoryRates.id, rowId));
  return row?.params.withoutItc === true;
}
