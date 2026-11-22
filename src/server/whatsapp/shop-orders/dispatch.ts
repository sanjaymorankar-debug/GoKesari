/**
 * Sends the queued shop WhatsApp messages (queue.ts writes them) and handles
 * a failure: the shop owner then hears in the app, by SMS (when an SMS
 * provider is set up) and by e-mail through the notification service, once
 * per event (docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md).
 *
 * Rows are claimed with SKIP LOCKED, so overlapping runs (timer, cron) never
 * send one message twice. Runs outside any transaction; Meta is called only here
 * and in webhook.ts (replies).
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { formatIndianMobile } from "@/lib/contact";
import { db } from "@/server/db";
import { orders, shopWhatsappContacts, shops, whatsappMessages, type WhatsappMessage } from "@/server/db/schema";
import { MetaWhatsAppError, metaWhatsAppProblem, sendMetaTemplate } from "@/server/notifications/providers/whatsapp-meta";
import { NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { getRule } from "@/server/services/settings";
import { ACCEPT_PREFIX, REJECT_PREFIX, loadNewOrderContent, loadOrderNumber, newOrderParams, newOrderText, shopOrderLink } from "./render";
import { whatsAppFeatureState } from "./state";

const MAX_ATTEMPTS = 3;

export interface DispatchResult {
  sent: number;
  failed: number;
  skipped: number;
  retrying: number;
  dormant?: string;
}

export async function dispatchWhatsAppQueue(options: { limit?: number } = {}): Promise<DispatchResult> {
  const tally: DispatchResult = { sent: 0, failed: 0, skipped: 0, retrying: 0 };

  // A run that died mid-send: the message may or may not have left, so it is not sent again — failed, with the fallback.
  const interrupted = await db
    .update(whatsappMessages)
    .set({ status: "FAILED", error: "Interrupted while sending (not retried, to avoid a duplicate).", failedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(whatsappMessages.status, "SENDING"), lte(whatsappMessages.updatedAt, sql`now() - interval '10 minutes'`)))
    .returning();
  for (const row of interrupted) await onMessageFailed(row);

  const state = await whatsAppFeatureState();
  if (!state.live) {
    // Switched off (or the keys went missing) after these were queued: they are not sent later by surprise.
    const reason = !state.flagOn ? "The feature flag whatsapp_shop_orders_enabled is off." : `WhatsApp is dormant: ${state.providerProblem}`;
    const skipped = await db
      .update(whatsappMessages)
      .set({ status: "SKIPPED", error: reason, updatedAt: new Date() })
      .where(eq(whatsappMessages.status, "QUEUED"))
      .returning({ id: whatsappMessages.id });
    tally.skipped += skipped.length;
    return { ...tally, dormant: reason };
  }

  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: whatsappMessages.id })
      .from(whatsappMessages)
      .where(eq(whatsappMessages.status, "QUEUED"))
      .orderBy(whatsappMessages.createdAt)
      .limit(options.limit ?? 50)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(whatsappMessages)
      .set({ status: "SENDING", attempts: sql`${whatsappMessages.attempts} + 1`, updatedAt: new Date() })
      .where(inArray(whatsappMessages.id, due.map((d) => d.id)))
      .returning();
  });

  const rule = await getRule("whatsappShopOrders");
  for (const row of claimed) {
    const outcome = await sendOne(row, rule.templateLanguage);
    tally[outcome] += 1;
  }
  return tally;
}

async function sendOne(row: WhatsappMessage, language: string): Promise<"sent" | "failed" | "skipped" | "retrying"> {
  const finish = (fields: Partial<typeof whatsappMessages.$inferInsert>) =>
    db.update(whatsappMessages).set({ ...fields, updatedAt: new Date() }).where(eq(whatsappMessages.id, row.id));

  let bodyParams: string[];
  let quickReplies: string[] | undefined;
  let body: string;
  if (row.kind === "NEW_ORDER") {
    const [order] = row.orderId ? await db.select({ status: orders.status }).from(orders).where(eq(orders.id, row.orderId)) : [];
    if (!order || order.status !== "CONFIRMED") {
      await finish({ status: "SKIPPED", error: order ? `The order is already ${order.status.toLowerCase()}.` : "The order no longer exists." });
      return "skipped";
    }
    const content = await loadNewOrderContent(row.orderId!);
    if (!content) {
      await finish({ status: "SKIPPED", error: "The order no longer exists." });
      return "skipped";
    }
    bodyParams = newOrderParams(content);
    quickReplies = [`${ACCEPT_PREFIX}${row.orderId}`, `${REJECT_PREFIX}${row.orderId}`];
    body = newOrderText(content);
  } else if (row.kind === "STATUS_UPDATE") {
    const orderNumber = row.orderId ? await loadOrderNumber(row.orderId) : null;
    const update = String(row.params?.update ?? "");
    bodyParams = [orderNumber ?? "—", update, row.orderId ? shopOrderLink(row.orderId) : "—"];
    body = `Order ${bodyParams[0]}: ${update}\n${bodyParams[2]}`;
  } else if (row.kind === "NUMBER_CHECK") {
    const shopName = String(row.params?.shopName ?? "your shop");
    bodyParams = [shopName];
    body = `GoKesari: this number will now get new orders of ${shopName} on WhatsApp.`;
  } else {
    await finish({ status: "SKIPPED", error: "Replies are sent at once, not from the queue." });
    return "skipped";
  }

  try {
    const result = await sendMetaTemplate({ to: row.intendedTo, name: row.template ?? "", language, bodyParams, quickReplies });
    await finish({
      status: "SENT",
      metaMessageId: result.messageId,
      sentTo: result.sentTo,
      sentAt: new Date(),
      params: { body: bodyParams, ...(quickReplies ? { buttons: quickReplies } : {}), ...(row.params ?? {}) },
      body,
      error: null,
      errorCode: null,
    });
    return "sent";
  } catch (error) {
    const err = error instanceof MetaWhatsAppError ? error : new MetaWhatsAppError(error instanceof Error ? error.message : String(error), null, true);
    if (err.retryable && row.attempts < MAX_ATTEMPTS) {
      await finish({ status: "QUEUED", error: err.message, errorCode: err.code, body });
      return "retrying";
    }
    const [failed] = await db
      .update(whatsappMessages)
      .set({ status: "FAILED", error: err.message, errorCode: err.code, failedAt: new Date(), body, updatedAt: new Date() })
      .where(eq(whatsappMessages.id, row.id))
      .returning();
    console.warn(`[whatsapp-shop-orders] send failed (${row.kind}, message ${row.id}): ${err.message}`);
    await onMessageFailed(failed ?? row);
    return "failed";
  }
}

/**
 * A message failed (at the API, or later by a "failed" status from the
 * webhook). A number check marks the number "not on WhatsApp"; an order alert
 * goes to the shop owner in the app, by SMS and by e-mail instead (rule
 * whatsappShopOrders.fallbackOnFailure), once per event.
 */
export async function onMessageFailed(row: WhatsappMessage): Promise<void> {
  try {
    if (row.kind === "NUMBER_CHECK") {
      if (row.contactId) {
        await db
          .update(shopWhatsappContacts)
          .set({ status: "NOT_ON_WHATSAPP", lastError: row.error, updatedAt: new Date() })
          .where(and(eq(shopWhatsappContacts.id, row.contactId), eq(shopWhatsappContacts.checkMessageId, row.id)));
      }
      return;
    }
    if (row.kind !== "NEW_ORDER" && row.kind !== "STATUS_UPDATE") return;
    if (!row.shopId || !row.orderId) return;
    if (!(await getRule("whatsappShopOrders")).fallbackOnFailure) return;
    const [info] = await db
      .select({ ownerId: shops.ownerId, orderNumber: orders.orderNumber, totalPaise: orders.totalPaise, paymentMethod: orders.paymentMethod })
      .from(orders)
      .innerJoin(shops, eq(shops.id, orders.shopId))
      .where(and(eq(orders.id, row.orderId), eq(shops.id, row.shopId)));
    if (!info) return;
    const number = formatIndianMobile(row.intendedTo);
    const why = (row.error ?? "not delivered").slice(0, 160);
    const text =
      row.kind === "NEW_ORDER"
        ? `New order ${info.orderNumber} (₹${(info.totalPaise / 100).toFixed(2)}${info.paymentMethod === "COD" ? ", cash on delivery" : ", prepaid"}) is waiting for you to accept. ` +
          `We could not deliver it to your WhatsApp ${number} (${why}). Open GoKesari to accept or reject it.`
        : `Order ${info.orderNumber}: ${String(row.params?.update ?? "status changed")} (WhatsApp ${number} could not be reached: ${why}.)`;
    await notify({
      userId: info.ownerId,
      type: NOTIFICATION_TYPES.SHOP_WHATSAPP_FAILED,
      vars: { orderNumber: info.orderNumber, text },
      actionUrl: `/shop/orders/${row.orderId}`,
      channels: ["SMS", "EMAIL"],
      metadata: { whatsappMessageId: row.id },
      dedupeKey: `wa-fallback:${row.groupKey ?? row.id}`,
    });
    await db.update(whatsappMessages).set({ fallbackAt: new Date(), updatedAt: new Date() }).where(eq(whatsappMessages.id, row.id));
  } catch (error) {
    console.error("[whatsapp-shop-orders] fallback failed for message", row.id, error);
  }
}

/** For the log page: why the feature is not sending, or null. */
export function whatsAppProviderProblem(): string | null {
  return metaWhatsAppProblem();
}
