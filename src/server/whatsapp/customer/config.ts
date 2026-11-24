/**
 * Customer WhatsApp: switches, provider mode and the template map
 * (docs/customer-whatsapp-2026-11/README.md).
 *
 *   flag whatsapp_customer_enabled        everything (consent switch, updates, chat)
 *   rule whatsappCustomer.enabled         the template updates (chat needs only the flag)
 *   WHATSAPP_PROVIDER=meta + META_WA_*    real WhatsApp (Meta Cloud API)
 *   WHATSAPP_PROVIDER=mock                test site / development: every message is
 *                                         written to outbound_test_messages
 *                                         (Admin → Test messages); refused on gokesari.com
 *
 * Nothing here is used while the flag is off.
 */
import { getEnv, messagingConfigProblem, type ServerEnv } from "@/lib/env";
import { metaWhatsAppProblem } from "@/server/notifications/providers/whatsapp-meta";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import type { RuleValue } from "@/server/config/rules";

export const CUSTOMER_WHATSAPP_FLAG = "whatsapp_customer_enabled" as const;

/** The update types the owner asked for (owner brief 23-Nov-2026), each with its own template in the rule. */
export const CUSTOMER_UPDATE_TYPES = [
  "ORDER_PLACED",
  "ORDER_CONFIRMED",
  "PAYMENT_RECEIVED",
  "ORDER_STATUS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "CANCELLED",
  "REFUND_ISSUED",
  "SUBSCRIPTION_RENEWAL",
] as const;
export type CustomerUpdateType = (typeof CUSTOMER_UPDATE_TYPES)[number];

const N = NOTIFICATION_TYPES;

/**
 * Which customer notifications also go out on WhatsApp, as which update. The
 * notification service calls the hook for every notification; anything not
 * listed here is never sent on WhatsApp by this module.
 */
export const NOTIFICATION_TO_UPDATE: Readonly<Record<string, CustomerUpdateType>> = {
  [N.ORDER_CONFIRMED]: "ORDER_PLACED",
  [N.ORDER_QUEUED_SHOP_CLOSED]: "ORDER_PLACED",
  [N.ORDER_ACCEPTED]: "ORDER_CONFIRMED",
  [N.ORDER_PAYMENT_CAPTURED]: "PAYMENT_RECEIVED",
  [N.ORDER_READY]: "ORDER_STATUS",
  [N.ORDER_ASSIGNED]: "ORDER_STATUS",
  [N.ORDER_PICKED_UP]: "ORDER_STATUS",
  [N.ORDER_DELIVERY_FAILED]: "ORDER_STATUS",
  [N.ORDER_RETURNED_TO_SHOP]: "ORDER_STATUS",
  [N.ORDER_OUT_FOR_DELIVERY]: "OUT_FOR_DELIVERY",
  [N.ORDER_DELIVERED]: "DELIVERED",
  [N.ORDER_CANCELLED]: "CANCELLED",
  [N.ORDER_PAYMENT_REFUNDED]: "REFUND_ISSUED",
  [N.ORDER_REFUND_UPDATED]: "REFUND_ISSUED",
  [N.RETURN_REFUND_COMPLETED]: "REFUND_ISSUED",
  [N.BANK_REFUND_PAID]: "REFUND_ISSUED",
  [N.SUBSCRIPTION_RENEWAL_DUE]: "SUBSCRIPTION_RENEWAL",
};

/** The update a notification type maps to, or null (not a customer WhatsApp update). */
export function customerUpdateFor(type: string): CustomerUpdateType | null {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_TO_UPDATE, type) ? NOTIFICATION_TO_UPDATE[type] : null;
}

/**
 * Some of the mapped types are also sent to the shop or the rider (a failed
 * delivery, a cancellation): those copies carry a staff-side link and are never
 * sent as customer WhatsApp.
 */
export function isStaffSideLink(actionUrl: string | null | undefined): boolean {
  return /^\/(shop|delivery|delivery-partner|admin|operator|staff|dealer|franchise)(\/|$|\?)/.test(actionUrl ?? "");
}

export type CustomerWhatsAppRule = RuleValue<"whatsappCustomer">;

/** The template for an update, or null when the rule leaves it empty (that update is not sent). */
export function templateFor(rule: Pick<CustomerWhatsAppRule, "templates">, update: CustomerUpdateType): string | null {
  const name = rule.templates[update]?.trim();
  return name ? name : null;
}

export type CustomerWhatsAppMode = "meta" | "mock";

/** How customer messages leave the server, or why they cannot. */
export function customerWhatsAppMode(env: ServerEnv = getEnv()): { mode: CustomerWhatsAppMode | null; problem: string | null } {
  if (env.WHATSAPP_PROVIDER === "meta") {
    const problem = metaWhatsAppProblem(env);
    return problem ? { mode: null, problem } : { mode: "meta", problem: null };
  }
  if (env.WHATSAPP_PROVIDER === "mock") {
    const problem = messagingConfigProblem(env);
    return problem ? { mode: null, problem } : { mode: "mock", problem: null };
  }
  return { mode: null, problem: 'WHATSAPP_PROVIDER is "none": set "meta" (with the META_WA_* keys) or, on the test site, "mock".' };
}

export interface CustomerWhatsAppState {
  flagOn: boolean;
  mode: CustomerWhatsAppMode | null;
  problem: string | null;
  /** Flag on and a way to send. */
  live: boolean;
}

export async function customerWhatsAppState(env: ServerEnv = getEnv()): Promise<CustomerWhatsAppState> {
  const flagOn = await isFeatureEnabled(CUSTOMER_WHATSAPP_FLAG);
  const { mode, problem } = customerWhatsAppMode(env);
  return { flagOn, mode, problem, live: flagOn && mode !== null };
}
