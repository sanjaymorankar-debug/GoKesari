/**
 * Notification templates and categories.
 *
 * A template gives an event its wording (`{{variables}}` filled in by
 * `render`), the category users can opt in or out of, and whether email is on
 * by default. Callers that already have their own text keep passing
 * title/body; the catalogue below covers every important event so new call
 * sites can just say `notify({ type, userId, vars })`.
 */
import { NOTIFICATION_TYPES as T } from "./types";

export type Channel = "IN_APP" | "EMAIL" | "SMS" | "PUSH" | "WHATSAPP";
export const OUTBOUND_CHANNELS = ["EMAIL", "SMS", "PUSH", "WHATSAPP"] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

export const CATEGORIES = {
  ORDERS: { label: "Your orders", description: "Placed, accepted, rider assigned, picked up, delivered, cancelled." },
  RETURNS: { label: "Returns & refunds", description: "Return requests, pickups, refunds." },
  DELIVERY: { label: "Deliveries", description: "Delivery offers and rider or dispatch updates." },
  SHOP: { label: "Shop operations", description: "New orders, approvals, suspensions, stock alerts." },
  WALLET: { label: "Wallet", description: "Top-ups and balance reminders." },
  SUBSCRIPTIONS: { label: "Subscriptions", description: "Upcoming and changed subscription deliveries." },
  COMMUNITY: { label: "Society", description: "Society membership and security notices." },
  MARKETING: { label: "Offers & campaigns", description: "Promotions from shops you have ordered from." },
  ACCOUNT_SECURITY: { label: "Account & security", description: "Sign-ins, number and role changes. Always sent." },
  GENERAL: { label: "Other updates", description: "Everything else." },
} as const;
export type CategoryKey = keyof typeof CATEGORIES;

/** Categories the user cannot switch off. */
export const MANDATORY_CATEGORIES: readonly CategoryKey[] = ["ACCOUNT_SECURITY"];

const PREFIX_CATEGORY: [string, CategoryKey][] = [
  ["order.", "ORDERS"],
  ["return.", "RETURNS"],
  ["delivery", "DELIVERY"],
  ["shop.", "SHOP"],
  ["inventory.", "SHOP"],
  ["product.", "SHOP"],
  ["wallet.", "WALLET"],
  ["subscription.", "SUBSCRIPTIONS"],
  ["society.", "COMMUNITY"],
  ["rating.", "COMMUNITY"],
  ["marketing.", "MARKETING"],
  ["security.", "ACCOUNT_SECURITY"],
  ["auth.", "ACCOUNT_SECURITY"],
];

export function categoryOf(type: string): CategoryKey {
  return PREFIX_CATEGORY.find(([prefix]) => type.startsWith(prefix))?.[1] ?? "GENERAL";
}

export interface Template {
  title: string;
  body: string;
  /** Email is sent by default (users can turn the category off). */
  emailByDefault: boolean;
}

const t = (title: string, body: string, emailByDefault = true): Template => ({ title, body, emailByDefault });

/** Important events. Variables are documented in the body text. */
export const TEMPLATES: Record<string, Template> = {
  [T.ORDER_CONFIRMED]: t("Order placed", "Your order {{orderNumber}} from {{shopName}} is confirmed."),
  [T.SHOP_ORDER_WHILE_CLOSED]: t(
    "New order while your shop is closed",
    "Order {{orderNumber}} ({{amount}}) was placed while {{shopName}} is closed; the customer chose to wait. You will get another alert when your shop opens.",
  ),
  [T.SHOP_OPENED_ORDERS_WAITING]: t(
    "Your shop is open — orders are waiting",
    "{{count}} order(s) placed while {{shopName}} was closed are waiting for you to accept.",
  ),
  [T.ORDER_QUEUED_SHOP_CLOSED]: t(
    "Order placed — shop is closed now",
    "Your order {{orderNumber}} was sent to {{shopName}}. The shop is closed right now, so it may be processed once it opens{{opensAt}}.",
  ),
  [T.ORDER_SHOP_NOW_OPEN]: t("The shop is open now", "{{shopName}} is open now and can accept your order {{orderNumber}}."),
  [T.ORDER_ACCEPTED]: t("Order accepted", "{{shopName}} accepted your order {{orderNumber}} and is preparing it."),
  [T.ORDER_ASSIGNED]: t("Rider assigned", "A rider has been assigned to your order {{orderNumber}}."),
  [T.ORDER_RIDER_ARRIVING]: t("Your rider is arriving", "Your rider for order {{orderNumber}} has reached you. Keep your delivery code ready."),
  [T.ORDER_PICKED_UP]: t("Order picked up", "Your order {{orderNumber}} has been picked up and is on its way."),
  [T.ORDER_DELIVERED]: t("Order delivered", "Your order {{orderNumber}} has been delivered. Enjoy!"),
  [T.ORDER_CANCELLED]: t("Order cancelled", "Your order {{orderNumber}} was cancelled. {{reason}}"),
  [T.ORDER_DELIVERY_FAILED]: t("Delivery attempt failed", "We could not deliver order {{orderNumber}}. {{reason}}"),
  [T.RETURN_REQUESTED]: t("Return requested", "Return {{returnNumber}} has been requested and is awaiting review."),
  [T.RETURN_APPROVED]: t("Return approved", "Return {{returnNumber}} is approved. {{nextStep}}"),
  [T.RETURN_REJECTED]: t("Return declined", "Return {{returnNumber}} was declined: {{reason}}"),
  [T.RETURN_REFUND_INITIATED]: t("Refund started", "Your refund of {{amount}} for return {{returnNumber}} is being processed."),
  [T.RETURN_REFUND_COMPLETED]: t("Refund completed", "{{amount}} for return {{returnNumber}} is back in your wallet."),
  [T.SHOP_SUSPENDED]: t(
    "Your shop has been suspended",
    "{{shopName}} was suspended on {{effectiveAt}}. Reason: {{reason}}. {{impact}} {{expectedAction}}",
  ),
  [T.SHOP_REACTIVATED]: t("Your shop is open again", "{{shopName}} has been reinstated and can take orders again."),
  [T.DELIVERY_SEARCH_STOPPED]: t(
    "Rider assignment failed",
    "No rider could be found for order {{orderNumber}}. {{detail}} You can try again or deliver it yourself.",
  ),
  [T.SECURITY_SIGN_IN]: t("New sign-in to your account", "Someone signed in to your Gokesari account using your mobile number at {{at}}. If this was not you, contact support."),
  [T.SECURITY_PHONE_CHANGED]: t("Mobile number changed", "The mobile number on your account was {{action}}. If this was not you, contact support."),
  [T.SECURITY_ROLE_CHANGED]: t("Account role changed", "Your account role was changed: {{detail}}."),
  [T.SECURITY_ACCOUNT_STATUS]: t("Account status changed", "Your account was {{status}}. {{detail}}"),
  [T.SHOP_APPROVED]: t("Shop approved", "{{shopName}} is approved and can start selling."),
  [T.SHOP_REJECTED]: t("Shop not approved", "{{shopName}} was not approved: {{reason}}"),
  [T.GRIEVANCE_RESOLVED]: t("Your complaint was resolved", "Ticket {{ticket}} has been resolved."),
};

/** Fills `{{name}}` placeholders; a missing variable becomes an empty string and extra spaces are tidied. */
export function interpolate(text: string, vars: Record<string, string | number | null | undefined> = {}): string {
  return text
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(vars[key] ?? ""))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export function renderTemplate(
  type: string,
  vars: Record<string, string | number | null | undefined>,
): { title: string; body: string } | null {
  const template = TEMPLATES[type];
  return template ? { title: interpolate(template.title, vars), body: interpolate(template.body, vars) } : null;
}

export function emailByDefault(type: string): boolean {
  return TEMPLATES[type]?.emailByDefault ?? false;
}

/* ---------------------------------------------------------------- email */

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderEmail(input: { title: string; body: string; actionUrl?: string | null; baseUrl?: string }): {
  subject: string;
  text: string;
  html: string;
} {
  // Only an in-app path ("/orders") or a full http(s) URL becomes a link; anything else is dropped.
  const raw = input.actionUrl ?? "";
  const link = raw.startsWith("/")
    ? `${(input.baseUrl ?? "").replace(/\/$/, "")}${raw}`
    : /^https?:\/\//i.test(raw)
      ? raw
      : null;
  const showLink = link !== null && /^https?:\/\//i.test(link);
  return {
    subject: `${input.title} — Gokesari`,
    text: `${input.title}\n\n${input.body}\n${showLink ? `\n${link}\n` : ""}\nYou receive this because of your notification settings on Gokesari.`,
    html:
      `<div style="font-family:system-ui,sans-serif;max-width:480px">` +
      `<h2 style="margin:0 0 8px;color:#1c1917">${escapeHtml(input.title)}</h2>` +
      `<p style="color:#44403c;line-height:1.5">${escapeHtml(input.body)}</p>` +
      (showLink
        ? `<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#ea580c;color:#fff;border-radius:8px;text-decoration:none">Open in Gokesari</a></p>`
        : "") +
      `<p style="color:#78716c;font-size:12px">You receive this because of your notification settings on Gokesari.</p></div>`,
  };
}

/** The sign-in code email. Rendered here for one consistent look, but never stored or queued. */
export function renderOtpEmail(code: string, expiryMinutes: number): { subject: string; text: string; html: string } {
  return {
    subject: `${code} is your Gokesari sign-in code`,
    text:
      `Your Gokesari sign-in code is ${code}.\n\n` +
      `It works once and expires in ${expiryMinutes} minutes. ` +
      `If you did not ask for it, ignore this email — nobody can sign in without the code.\n`,
    html:
      `<p>Your Gokesari sign-in code is</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>` +
      `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. ` +
      `If you did not ask for it, ignore this email.</p>`,
  };
}
