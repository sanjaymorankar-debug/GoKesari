/**
 * Fulfilment options (docs/four-features-2026-10, feature 1): the checks the
 * existing order and dispatch code asks before it moves an order on. Kept
 * free of imports from orders.ts / delivery-assignment.ts so both can call it
 * without an import cycle.
 *
 * Orders without an arrangement (every order placed before the feature, and
 * every order while rule fulfilmentOptions is off) pass every check unchanged.
 */
import { eq } from "drizzle-orm";

import { conflict } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { orderFulfilmentArrangements, type Order, type OrderFulfilmentArrangement, type OrderStatus } from "@/server/db/schema";
import { getRule } from "./settings";

export async function arrangementFor(orderId: string, client: DbClient = db): Promise<OrderFulfilmentArrangement | null> {
  const [row] = await client.select().from(orderFulfilmentArrangements).where(eq(orderFulfilmentArrangements.orderId, orderId));
  return row ?? null;
}

/**
 * Called by updateOrderStatus (orders.ts) under the order's row lock:
 *  - pickup and own-delivery orders complete only with the customer's code
 *    (fulfilment-options.ts sets completed_at first, in the same transaction);
 *  - a pickup order never goes "out for delivery";
 *  - an own-delivery order goes out only through its delivery plan (which
 *    sends the customer their code);
 *  - a GoKesari-partner order is handed over by the rider flow, not by the
 *    shop's manual READY → out for delivery / delivered buttons.
 */
export async function assertFulfilmentAllowsStatus(
  client: DbClient,
  order: Pick<Order, "id" | "status">,
  newStatus: OrderStatus,
): Promise<void> {
  if (newStatus !== "DELIVERED" && newStatus !== "OUT_FOR_DELIVERY") return;
  const plan = await arrangementFor(order.id, client);
  if (!plan) return;
  if (plan.option === "PICKUP") {
    if (newStatus === "OUT_FOR_DELIVERY") {
      throw conflict("This order is for pickup. Change the delivery plan to send it out for delivery.");
    }
    if (!plan.completedAt) {
      throw conflict("Complete a pickup with the customer's pickup code.");
    }
    return;
  }
  if (plan.option === "SHOP_DELIVERY") {
    if (newStatus === "OUT_FOR_DELIVERY" && !plan.outForDeliveryAt) {
      throw conflict("Send the order out from its delivery plan, so the customer gets their delivery code.");
    }
    if (newStatus === "DELIVERED" && !plan.completedAt) {
      throw conflict("Complete the delivery with the customer's delivery code.");
    }
    return;
  }
  // GOKESARI_PARTNER: the rider flow moves PICKED_UP → OUT_FOR_DELIVERY → DELIVERED.
  if (order.status === "READY") {
    throw conflict("A GoKesari delivery partner will collect this order. Change the delivery plan to deliver it yourself.");
  }
}

/**
 * Called by dispatchReadyOrder (delivery-assignment.ts): true when no rider
 * should be looked for now — the shop chose pickup or its own delivery, or a
 * GoKesari delivery for a later slot (the dispatch sweep tries again; the
 * shop's own "Find rider now" goes straight through).
 */
export async function holdsRiderDispatch(orderId: string, trigger: string, now: Date = new Date()): Promise<boolean> {
  const plan = await arrangementFor(orderId);
  if (!plan) return false;
  if (plan.option !== "GOKESARI_PARTNER") return true;
  if (trigger === "SHOP_MANUAL") return false;
  const { gokesariLeadMinutes } = await getRule("fulfilmentOptions");
  return now.getTime() < plan.scheduledStart.getTime() - gokesariLeadMinutes * 60_000;
}

/**
 * Called by markOrderReady (fulfilment.ts) when the shop marks an order ready
 * without choosing: with rule fulfilmentOptions on, a choice is required.
 */
export async function assertFulfilmentChosen(client: DbClient, orderId: string): Promise<void> {
  if (!(await getRule("fulfilmentOptions")).enabled) return;
  if (await arrangementFor(orderId, client)) return;
  throw conflict("Choose pickup, your own delivery or a GoKesari delivery partner, and a time, before marking the order ready.", {
    needsFulfilmentChoice: true,
  });
}
