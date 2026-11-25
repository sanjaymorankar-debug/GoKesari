/**
 * Customer updates on WhatsApp (docs/customer-whatsapp-2026-11/README.md).
 *
 * notify() (services/notifications.ts) calls this for every notification it
 * writes. When the notification is one of the customer updates
 * (config.NOTIFICATION_TO_UPDATE) and everything allows it — flag on, rule on,
 * a template for that update, a provider (Meta, or the mock on the test site),
 * a customer-side link, a verified mobile number, WhatsApp consent and no
 * WhatsApp opt-out in the category's preferences — one QUEUED
 * whatsapp_messages row (kind CUSTOMER_NOTIFICATION) is written in the caller's
 * transaction. The shared dispatcher (shop-orders/dispatch.ts) sends it after
 * commit with the same retries and log as the shop alerts.
 *
 * Never throws (except a serialization failure inside the caller's transaction,
 * which that transaction re-runs). With the flag off it returns at once.
 */
import { db, isRetryableTransactionError, type DbClient } from "@/server/db";
import { whatsappMessages } from "@/server/db/schema";
import { getRule } from "@/server/services/settings";
import { scheduleWhatsAppDispatch } from "@/server/whatsapp/shop-orders/queue";
import { siteUrl } from "@/server/whatsapp/shop-orders/render";
import { customerUpdateFor, customerWhatsAppState, isStaffSideLink, templateFor } from "./config";
import { customerSendBlock, hasWhatsAppConsent, verifiedPhoneOf } from "./consent";

export interface CustomerNotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  actionUrl?: string | null;
  dedupeKey?: string | null;
  notificationId: string | null;
  /** The user's WHATSAPP preference for this notification's category (undefined = never chosen). */
  whatsappPreference: boolean | undefined;
}

/** The three template body parameters: {{1}} title, {{2}} message, {{3}} link. */
export function customerTemplateParams(title: string, body: string, actionUrl: string | null | undefined): string[] {
  return [title, body, actionUrl ? (actionUrl.startsWith("http") ? actionUrl : siteUrl(actionUrl)) : siteUrl("/orders")];
}

/** Queues the WhatsApp copy of a customer notification. True when a row was queued. */
export async function queueCustomerWhatsAppForNotification(input: CustomerNotificationInput, client: DbClient = db): Promise<boolean> {
  const update = customerUpdateFor(input.type);
  if (!update) return false;
  try {
    const state = await customerWhatsAppState();
    if (!state.flagOn) return false;
    const rule = await getRule("whatsappCustomer");
    const template = templateFor(rule, update);
    const verifiedPhone = await verifiedPhoneOf(input.userId, client);
    const block = customerSendBlock({
      flagOn: state.flagOn,
      ruleEnabled: rule.enabled,
      template,
      providerReady: state.mode !== null,
      staffCopy: isStaffSideLink(input.actionUrl),
      verifiedPhone,
      consented: verifiedPhone ? await hasWhatsAppConsent(input.userId, client) : false,
      channelPreference: input.whatsappPreference,
    });
    if (block) return false;

    const params = customerTemplateParams(input.title, input.body, input.actionUrl);
    const key = input.dedupeKey ?? input.notificationId;
    const rows = await client
      .insert(whatsappMessages)
      .values({
        userId: input.userId,
        kind: "CUSTOMER_NOTIFICATION",
        eventType: input.type,
        template,
        params: { update, title: params[0], text: params[1], link: params[2] },
        body: params.join("\n"),
        intendedTo: verifiedPhone!,
        status: "QUEUED",
        dedupeKey: key ? `cust:${input.userId}:${key}` : null,
        groupKey: key ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: whatsappMessages.id });
    if (rows.length > 0) scheduleWhatsAppDispatch(client !== db);
    return rows.length > 0;
  } catch (error) {
    if (client !== db && isRetryableTransactionError(error)) throw error;
    console.error("[whatsapp-customer] could not queue", input.type, input.userId, error);
    return false;
  }
}
