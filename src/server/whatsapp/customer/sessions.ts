/**
 * Inbound customer chat on WhatsApp (docs/customer-whatsapp-2026-11/README.md):
 * the webhook (or, on the test site, Admin → WhatsApp messages → Simulate)
 * hands every non-button text here when flag whatsapp_customer_enabled is on.
 *
 *   1. rate limit per phone (rule whatsappCustomer.rateLimitPerMinute): over the
 *      limit the bot answers once, then stays quiet until the minute is over;
 *   2. STOP / START: consent (a known customer's WHATSAPP_NOTIFICATIONS row,
 *      source WHATSAPP_KEYWORD) and the chat's own opt-out;
 *   3. after STOP nothing is answered except START;
 *   4. otherwise the conversation (conversation.ts) with the real catalogue
 *      search (products on sale online at shops that deliver to the PIN code)
 *      and the signed checkout link (cart-link.ts).
 *
 * Replies are sent after the session is saved, never inside a transaction.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { formatStock } from "@/lib/stock-quantity";
import type { CustomerLocation } from "@/lib/location";
import { db } from "@/server/db";
import { users, whatsappCustomerSessions, type WhatsAppPickOption, type WhatsappCustomerSession } from "@/server/db/schema";
import { listAddresses } from "@/server/services/addresses";
import { listStorefrontProducts } from "@/server/services/catalogue";
import { serviceableShopIds } from "@/server/services/serviceability";
import { getRule } from "@/server/services/settings";
import { createCartLink } from "./cart-link";
import { customerWhatsAppState } from "./config";
import { parseConsentKeyword, setWhatsAppConsent } from "./consent";
import { converse, type BotReply, type SessionSnapshot } from "./conversation";
import { sendCustomerReply } from "./send";

/* ------------------------------------------------------------ rate limit */

export interface RateWindow {
  windowStartedAt: Date;
  windowCount: number;
  /** Handle this message. */
  allowed: boolean;
  /** The first message over the limit in this window: tell the person once. */
  notify: boolean;
}

/** A fixed one-minute window per phone. */
export function nextRateWindow(current: { windowStartedAt: Date; windowCount: number }, now: Date, limitPerMinute: number): RateWindow {
  const fresh = now.getTime() - current.windowStartedAt.getTime() >= 60_000;
  const windowStartedAt = fresh ? now : current.windowStartedAt;
  const windowCount = (fresh ? 0 : current.windowCount) + 1;
  return { windowStartedAt, windowCount, allowed: windowCount <= limitPerMinute, notify: windowCount === limitPerMinute + 1 };
}

/* ---------------------------------------------------------------- search */

/** Products on sale online at shops that deliver to this PIN code, buyable first. */
export async function searchNearPincode(query: string, pincode: string, limit: number): Promise<WhatsAppPickOption[]> {
  const location: CustomerLocation = { label: `PIN ${pincode}`, pincode, latitude: null, longitude: null, source: "PINCODE", addressId: null, societyId: null };
  const distances = await serviceableShopIds(location);
  if (distances.size === 0) return [];
  const rows = await listStorefrontProducts({ query, shopIds: [...distances.keys()], onlineOnly: true, limit: Math.min(limit * 3, 30) });
  return rows
    .filter((r) => r.onlinePricePaise != null)
    .map((r) => {
      const buyable = r.isAvailable && (!r.trackInventory || r.onlineStock > 0);
      const availability = !buyable ? "Out of stock" : r.trackInventory && r.onlineStock <= 5 ? `Only ${formatStock(r.onlineStock)} left` : "In stock";
      return {
        option: { shopProductId: r.shopProductId, name: r.productName, shopName: r.shopName, unitPricePaise: r.onlinePricePaise!, availability, buyable },
        distance: distances.get(r.shopId) ?? Number.POSITIVE_INFINITY,
      };
    })
    .sort((a, b) => Number(b.option.buyable) - Number(a.option.buyable) || a.distance - b.distance)
    .slice(0, limit)
    .map((r) => r.option);
}

/* --------------------------------------------------------------- session */

async function loadSession(phone: string, ttlMinutes: number): Promise<WhatsappCustomerSession> {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await db.insert(whatsappCustomerSessions).values({ phoneE164: phone, expiresAt }).onConflictDoNothing();
  const [session] = await db.select().from(whatsappCustomerSessions).where(eq(whatsappCustomerSessions.phoneE164, phone));
  if (session.expiresAt.getTime() <= Date.now()) {
    // Expired: the conversation and the chat cart are forgotten; the PIN code and an opt-out stay.
    return { ...session, state: "IDLE", context: {}, cart: [] };
  }
  return session;
}

async function customerForPhone(phone: string): Promise<{ id: string } | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.phoneE164, phone), isNull(users.deletedAt), isNotNull(users.phoneVerifiedAt)));
  return user ?? null;
}

export interface CustomerInbound {
  /** E.164 of the sender. */
  from: string;
  text: string;
  inboundId: string;
}

/** Handles one inbound customer text. Returns a short result for the webhook log. */
export async function handleCustomerInbound(message: CustomerInbound): Promise<string> {
  const state = await customerWhatsAppState();
  if (!state.flagOn) return "customer chat off";
  if (!state.mode) return `customer chat dormant: ${state.problem}`;
  const rule = await getRule("whatsappCustomer");
  const now = new Date();
  const session = await loadSession(message.from, rule.sessionTtlMinutes);
  const user = await customerForPhone(message.from);
  const expiresAt = new Date(now.getTime() + rule.sessionTtlMinutes * 60_000);

  const save = (fields: Partial<typeof whatsappCustomerSessions.$inferInsert>) =>
    db
      .update(whatsappCustomerSessions)
      .set({ ...fields, userId: user?.id ?? null, lastInboundAt: now, expiresAt, updatedAt: now })
      .where(eq(whatsappCustomerSessions.id, session.id));
  const reply = (r: BotReply) => sendCustomerReply(message.from, r, user?.id ?? null);

  const window = nextRateWindow(session, now, rule.rateLimitPerMinute);
  if (!window.allowed) {
    await save({ windowStartedAt: window.windowStartedAt, windowCount: window.windowCount });
    if (window.notify && !session.optedOutAt) await reply({ text: "You are sending messages very fast. Please wait a minute and try again." });
    return "rate limited";
  }
  const rate = { windowStartedAt: window.windowStartedAt, windowCount: window.windowCount };

  const keyword = parseConsentKeyword(message.text);
  if (keyword === "STOP") {
    await save({ ...rate, optedOutAt: now, state: "IDLE", context: {} });
    if (user) await setWhatsAppConsent(user.id, false, { source: "WHATSAPP_KEYWORD" });
    await reply({ text: "You will no longer get WhatsApp messages from GoKesari. Send START at any time to turn them back on." });
    return "opted out (STOP)";
  }
  if (keyword === "START") {
    await save({ ...rate, optedOutAt: null });
    if (user) await setWhatsAppConsent(user.id, true, { source: "WHATSAPP_KEYWORD" });
    await reply({
      text: user
        ? "WhatsApp updates are on: you will get order, payment and delivery updates here. Send a product name to shop, or STOP to turn them off."
        : "Chat is on. Send a product name to shop. To get order updates here, sign in on GoKesari with this mobile number.",
    });
    return "opted in (START)";
  }
  if (session.optedOutAt) {
    await save(rate);
    return "ignored: opted out";
  }

  let pincode = session.pincode;
  if (!pincode && user) pincode = (await listAddresses(user.id))[0]?.pincode ?? null;
  const snapshot: SessionSnapshot = { state: session.state, context: session.context ?? {}, cart: session.cart ?? [], pincode };
  const result = await converse(snapshot, message.text, {
    search: (query, pin) => searchNearPincode(query, pin, rule.maxResults),
    checkoutLink: async (cart) => {
      const link = await createCartLink({ sessionId: session.id, phone: message.from, userId: user?.id ?? null, lines: cart, ttlMinutes: rule.checkoutLinkTtlMinutes });
      return { url: link.url, expiresInMinutes: rule.checkoutLinkTtlMinutes };
    },
    maxResults: rule.maxResults,
    maxQuantity: rule.maxQuantity,
  });
  await save({ ...rate, state: result.session.state, context: result.session.context, cart: result.session.cart, pincode: result.session.pincode });
  for (const r of result.replies) await reply(r);
  return `chat: ${snapshot.state} → ${result.session.state}`;
}
