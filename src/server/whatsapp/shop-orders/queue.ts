/**
 * The WhatsApp outbox for shop-order alerts (docs/smart-shopping-2026-11/
 * FEATURE3_WHATSAPP_ORDERS.md).
 *
 * emitEvent() (server/events/emit.ts) calls queueShopWhatsAppForEvent inside
 * the transaction that changed the order: it writes one QUEUED
 * whatsapp_messages row per verified, opted-in number of the shop — nothing
 * leaves the server here. The rows become visible when that transaction
 * commits, and dispatch.ts sends them: a moment later (timer), or at the
 * every-minute cron at the latest. One row per (event, number) — the unique
 * dedupe key — so a repeated event or a retried request never sends twice.
 *
 *   order.placed                          → new order, with [Accept] [Reject]
 *   order.cancelled by the customer       → status update
 *   order.assigned (delivery partner)     → status update
 *   order.delivered                       → status update
 */
import { eq, sql } from "drizzle-orm";

import { db, isRetryableTransactionError, type DbClient } from "@/server/db";
import { orders, shops, type UserRole } from "@/server/db/schema";
import type { EventPayload, EventType } from "@/server/events/catalog";
import { getRule } from "@/server/services/settings";
import { whatsAppLiveForShop } from "./state";

export interface QueuePlan {
  kind: "NEW_ORDER" | "STATUS_UPDATE";
  /** The status line of a STATUS_UPDATE. */
  update?: string;
}

/** What, if anything, an event sends to the shop's WhatsApp. */
export function whatsAppPlanFor(type: string, payload: Record<string, unknown>, actorRole: UserRole | null): QueuePlan | null {
  switch (type) {
    case "order.placed":
      return { kind: "NEW_ORDER" };
    case "order.cancelled": {
      if (payload.cancelledBy !== "CUSTOMER") return null;
      const reason = typeof payload.reason === "string" && payload.reason.trim() ? `: ${payload.reason.trim()}` : "";
      return { kind: "STATUS_UPDATE", update: `Cancelled by the customer${reason}. Put the items back on the shelf.` };
    }
    case "order.assigned": {
      const name = (payload.shopRiderName ?? payload.riderName) as string | null | undefined;
      return { kind: "STATUS_UPDATE", update: `Delivery partner assigned${name ? `: ${name}` : ""}. Keep the order ready for pickup.` };
    }
    case "order.delivered":
      return {
        kind: "STATUS_UPDATE",
        update: actorRole === "DELIVERY_PARTNER" ? "Delivered — the customer confirmed with their delivery code (OTP)." : "Delivered to the customer.",
      };
    default:
      return null;
  }
}

/**
 * Queues the event's WhatsApp messages in the caller's transaction. Never
 * throws (except a serialization failure / deadlock, which the caller's
 * transaction re-runs): a WhatsApp problem must never undo an order.
 */
export async function queueShopWhatsAppForEvent<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  eventId: string,
  actorRole: UserRole | null,
  client: DbClient,
): Promise<number> {
  const plan = whatsAppPlanFor(type, payload as unknown as Record<string, unknown>, actorRole);
  const orderId = (payload as { orderId?: string }).orderId;
  if (!plan || !orderId) return 0;
  try {
    const [order] = await client
      .select({ shopId: orders.shopId, pincode: shops.pincode })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(eq(orders.id, orderId));
    if (!order) return 0;
    if (!(await whatsAppLiveForShop({ pincode: order.pincode }))) return 0;
    const rule = await getRule("whatsappShopOrders");
    const template = plan.kind === "NEW_ORDER" ? rule.newOrderTemplate : rule.statusUpdateTemplate;
    const params = plan.update ? { update: plan.update } : {};
    // One statement: the shop's switch, its verified numbers and the outbox rows together.
    const rows = await client.execute(sql`
      INSERT INTO whatsapp_messages (shop_id, order_id, contact_id, kind, event_type, template, params, intended_to, status, dedupe_key, group_key)
      SELECT c.shop_id, ${orderId}::uuid, c.id, ${plan.kind}, ${type}, ${template}, ${JSON.stringify(params)}::jsonb, c.phone_e164, 'QUEUED',
             ${eventId} || ':' || c.id::text, ${eventId}
      FROM shop_whatsapp_contacts c
      JOIN shop_whatsapp_settings s ON s.shop_id = c.shop_id AND s.enabled
      WHERE c.shop_id = ${order.shopId}::uuid AND c.status = 'ACTIVE' AND c.opted_in AND c.removed_at IS NULL
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `);
    const queued = Array.isArray(rows) ? rows.length : ((rows as { length?: number }).length ?? 0);
    if (queued > 0) scheduleWhatsAppDispatch(client !== db);
    return queued;
  } catch (error) {
    if (client !== db && isRetryableTransactionError(error)) throw error;
    console.error("[whatsapp-shop-orders] could not queue", type, orderId, error);
    return 0;
  }
}

/* ------------------------------------------------------------ dispatching */

let autoDispatch = true;

/** Tests run the dispatcher themselves (no timers behind their back). */
export function setWhatsAppAutoDispatch(on: boolean): void {
  autoDispatch = on;
}

/**
 * Sends the queue soon. Rows queued inside a transaction are visible only
 * after it commits, so the run waits a moment (and once more a little
 * later); the every-minute cron catches anything still left.
 */
export function scheduleWhatsAppDispatch(insideTransaction = true): void {
  if (!autoDispatch) return;
  const run = () =>
    void import("./dispatch")
      .then((m) => m.dispatchWhatsAppQueue())
      .catch((error) => console.error("[whatsapp-shop-orders] dispatch failed", error));
  for (const delay of insideTransaction ? [1_000, 5_000] : [0]) setTimeout(run, delay).unref?.();
}
