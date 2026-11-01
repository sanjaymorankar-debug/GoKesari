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
import { and, desc, eq } from "drizzle-orm";

import { gstState } from "@/lib/gst-states";
import { db, type DbClient } from "@/server/db";
import {
  addresses,
  deliveryOrders,
  deliveryPartners,
  orderFulfilmentArrangements,
  orderMoneyFlows,
  orders,
  shops,
  type OrderMoneyFlow,
} from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { istDay, statutoryResolver, tcsOn, tdsOn, unregisteredRulesOn } from "@/server/statutory/rates";
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
  const platformState = (await getRule("platformTaxProfile")).stateCode || null;
  const s95 = (await isFeatureEnabled("delivery_9_5")) ? await resolve("GST_S95_LOCAL_DELIVERY", day) : null;
  const delivery = deliveryFeeGst({
    fulfilment,
    feePaise: order.deliveryFeePaise,
    riderGstRegistered,
    supply: supplyTypeOf(platformState, gstState(address?.state ?? null)?.alpha ?? null),
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
  return row ?? null;
}
