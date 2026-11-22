/**
 * The WhatsApp webhook (POST /api/webhooks/whatsapp; docs/smart-shopping-2026-11/
 * FEATURE3_WHATSAPP_ORDERS.md).
 *
 *   - Signed: X-Hub-Signature-256 is the HMAC-SHA256 of the raw body with
 *     META_WA_APP_SECRET; anything else is refused (401).
 *   - Idempotent: each message id and each (message id, status) is handled
 *     once (whatsapp_webhook_events); Meta's retries change nothing.
 *   - Status updates (sent / delivered / read / failed) update the message log;
 *     a delivered or read number check makes the number "active on WhatsApp";
 *     a failed order alert sends the fallback (in-app, SMS, e-mail).
 *   - A button tap calls the same acceptOrder / rejectOrder as the app, as the
 *     shop owner, once the sender is checked to be a verified number of THAT
 *     order's shop. A Reject uses the reason "Rejected on WhatsApp" (no
 *     follow-up question). The first action wins across WhatsApp and the app
 *     and across all of the shop's numbers: the order row lock and the order
 *     state machine decide (CONFIRMED → ACCEPTED happens once; a Reject only
 *     while still CONFIRMED). Everyone later is told who was first and when.
 *     The customer hears through the order events, exactly as from the app.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";

import { formatIndianMobile } from "@/lib/contact";
import { AppError } from "@/lib/errors";
import { formatIst } from "@/lib/franchise";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import {
  orderStatusHistory,
  orders,
  shopWhatsappContacts,
  shops,
  users,
  whatsappMessages,
  whatsappOrderActions,
  whatsappWebhookEvents,
  type ShopWhatsappContact,
  type WhatsappMessage,
} from "@/server/db/schema";
import { MetaWhatsAppError, sendMetaText, toE164, whatsappTestRecipient } from "@/server/notifications/providers/whatsapp-meta";
import { acceptOrder, rejectOrder } from "@/server/services/fulfilment";
import { onMessageFailed } from "./dispatch";
import { parseButtonPayload, shopOrderLink } from "./render";
import { whatsAppFeatureState } from "./state";

/** The reason a WhatsApp Reject gives the customer (no follow-up question is asked). */
export const WHATSAPP_REJECT_REASON = "Rejected on WhatsApp";

/* ------------------------------------------------------------- signature */

export function whatsappSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

export function isValidWhatsAppSignature(rawBody: string, header: string | null, secret: string | undefined): boolean {
  if (!secret?.trim() || !header) return false;
  const expected = Buffer.from(whatsappSignature(rawBody, secret.trim()));
  const given = Buffer.from(header.trim().toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** GET: Meta's subscription check. The challenge echoed back only for our verify token. */
export function verifyWhatsAppSubscription(params: URLSearchParams): { status: number; body: string } {
  const token = getEnv().META_WA_VERIFY_TOKEN?.trim();
  const given = params.get("hub.verify_token") ?? "";
  const ok =
    params.get("hub.mode") === "subscribe" &&
    Boolean(token) &&
    given.length === token!.length &&
    timingSafeEqual(Buffer.from(given), Buffer.from(token!));
  return ok ? { status: 200, body: params.get("hub.challenge") ?? "" } : { status: 403, body: "Forbidden" };
}

/* -------------------------------------------------------------- payloads */

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

interface MetaInbound {
  id?: string;
  from?: string;
  type?: string;
  context?: { id?: string; from?: string };
  button?: { payload?: string; text?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
}

interface MetaWebhookBody {
  object?: string;
  entry?: { changes?: { field?: string; value?: { statuses?: MetaStatus[]; messages?: MetaInbound[] } }[] }[];
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export async function handleWhatsAppWebhook(rawBody: string, headers: Headers): Promise<WebhookResult> {
  const secret = getEnv().META_WA_APP_SECRET;
  if (!secret?.trim()) {
    console.warn("[whatsapp-webhook] META_WA_APP_SECRET is not set: webhook refused.");
    return { status: 503, body: { error: "WhatsApp is not set up on this server." } };
  }
  if (!isValidWhatsAppSignature(rawBody, headers.get("x-hub-signature-256"), secret)) {
    console.warn("[whatsapp-webhook] refused: bad or missing X-Hub-Signature-256");
    return { status: 401, body: { error: "Invalid signature." } };
  }
  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody) as MetaWebhookBody;
  } catch {
    return { status: 400, body: { error: "Invalid JSON." } };
  }
  const state = await whatsAppFeatureState();
  if (!state.flagOn) return { status: 200, body: { ignored: "whatsapp_shop_orders_enabled is off" } };

  const results: string[] = [];
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== "messages") continue;
      for (const status of change.value?.statuses ?? []) results.push(await handleStatus(status));
      for (const message of change.value?.messages ?? []) results.push(await handleInbound(message));
    }
  }
  return { status: 200, body: { ok: true, results } };
}

/** True the first time this key is seen (and records it); false for a repeat. */
async function firstTime(eventKey: string, kind: "MESSAGE" | "STATUS", fromNumber: string | null, payload: object): Promise<string | null> {
  const [row] = await db
    .insert(whatsappWebhookEvents)
    .values({ eventKey, kind, fromNumber, payload: payload as Record<string, unknown> })
    .onConflictDoNothing()
    .returning({ id: whatsappWebhookEvents.id });
  return row?.id ?? null;
}

async function noteResult(eventId: string, result: string): Promise<string> {
  await db.update(whatsappWebhookEvents).set({ result: result.slice(0, 300) }).where(eq(whatsappWebhookEvents.id, eventId));
  return result;
}

/* ---------------------------------------------------------------- status */

const RANK: Record<string, number> = { QUEUED: 0, SENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };

async function handleStatus(status: MetaStatus): Promise<string> {
  const wamid = status.id;
  const value = (status.status ?? "").toLowerCase();
  if (!wamid || !["sent", "delivered", "read", "failed"].includes(value)) return "status ignored";
  const eventId = await firstTime(`status:${wamid}:${value}`, "STATUS", status.recipient_id ? toE164(status.recipient_id) : null, status);
  if (!eventId) return "status duplicate";
  const [message] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.metaMessageId, wamid));
  if (!message) return noteResult(eventId, "status for an unknown message");
  const at = status.timestamp && /^\d+$/.test(status.timestamp) ? new Date(Number(status.timestamp) * 1000) : new Date();

  if (value === "failed") {
    // Delivered or read already: a late "failed" (e.g. for one device) does not undo that.
    if (message.status === "DELIVERED" || message.status === "READ") return noteResult(eventId, "failed after delivery ignored");
    const err = status.errors?.[0];
    const error = [err?.code, err?.title ?? err?.message, err?.error_data?.details].filter(Boolean).join(" — ") || "Failed (no reason given)";
    const [failed] = await db
      .update(whatsappMessages)
      .set({ status: "FAILED", error: error.slice(0, 500), errorCode: err?.code != null ? String(err.code) : null, failedAt: at, updatedAt: new Date() })
      .where(eq(whatsappMessages.id, message.id))
      .returning();
    console.warn(`[whatsapp-shop-orders] message ${message.id} (${message.kind}) failed: ${error}`);
    await onMessageFailed(failed);
    return noteResult(eventId, "failed");
  }

  const next = value === "read" ? "READ" : value === "delivered" ? "DELIVERED" : "SENT";
  const keep = message.status === "FAILED" ? next : (RANK[message.status] ?? 0) >= RANK[next] ? message.status : next;
  await db
    .update(whatsappMessages)
    .set({
      status: keep as WhatsappMessage["status"],
      ...(next === "SENT" && !message.sentAt ? { sentAt: at } : {}),
      ...(next !== "SENT" && !message.deliveredAt ? { deliveredAt: at } : {}),
      ...(next === "READ" ? { readAt: message.readAt ?? at } : {}),
      ...(message.status === "FAILED" ? { error: null, errorCode: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(whatsappMessages.id, message.id));

  if (message.kind === "NUMBER_CHECK" && message.contactId && (next === "DELIVERED" || next === "READ")) {
    await db
      .update(shopWhatsappContacts)
      .set({ status: "ACTIVE", verifiedAt: at, lastError: null, updatedAt: new Date() })
      .where(and(eq(shopWhatsappContacts.id, message.contactId), eq(shopWhatsappContacts.checkMessageId, message.id)));
  }
  return noteResult(eventId, next.toLowerCase());
}

/* --------------------------------------------------------- button taps */

async function handleInbound(message: MetaInbound): Promise<string> {
  if (!message.id || !message.from) return "message ignored";
  const from = toE164(message.from);
  const eventId = await firstTime(`msg:${message.id}`, "MESSAGE", from, message);
  if (!eventId) return "message duplicate";
  const payload = message.button?.payload ?? message.interactive?.button_reply?.id ?? null;
  const tap = parseButtonPayload(payload);
  if (!tap) return noteResult(eventId, `not a button tap (${message.type ?? "unknown"})`);
  const result = await processButtonTap({ from, action: tap.action, orderId: tap.orderId, contextId: message.context?.id ?? null, inboundId: message.id });
  return noteResult(eventId, result);
}

export interface ButtonTap {
  /** E.164 of the sender. */
  from: string;
  action: "ACCEPT" | "REJECT";
  orderId: string;
  /** Meta id of the message whose button was tapped. */
  contextId: string | null;
  inboundId: string;
}

/**
 * The sender's verified contact for this order's shop, or null. On the test
 * site every message went to one test number, so a tap from that number on a
 * message we sent stands for the number that message was meant for.
 */
async function senderContact(tap: ButtonTap, shopId: string): Promise<ShopWhatsappContact | null> {
  const live = and(
    eq(shopWhatsappContacts.shopId, shopId),
    isNull(shopWhatsappContacts.removedAt),
    eq(shopWhatsappContacts.status, "ACTIVE"),
    eq(shopWhatsappContacts.optedIn, true),
  );
  const testNumber = whatsappTestRecipient();
  if (tap.contextId) {
    const [sent] = await db.select().from(whatsappMessages).where(eq(whatsappMessages.metaMessageId, tap.contextId));
    if (sent && sent.orderId === tap.orderId && sent.contactId && sent.sentTo === tap.from && (sent.intendedTo === tap.from || sent.sentTo === testNumber)) {
      const [contact] = await db.select().from(shopWhatsappContacts).where(and(eq(shopWhatsappContacts.id, sent.contactId), live));
      if (contact) return contact;
    }
  }
  const [contact] = await db.select().from(shopWhatsappContacts).where(and(live, eq(shopWhatsappContacts.phoneE164, tap.from)));
  return contact ?? null;
}

export async function processButtonTap(tap: ButtonTap): Promise<string> {
  const [order] = await db
    .select({ id: orders.id, shopId: orders.shopId, orderNumber: orders.orderNumber, ownerId: shops.ownerId })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(eq(orders.id, tap.orderId));
  if (!order) {
    await reply(tap.from, null, null, "GoKesari: this order could not be found.");
    return "unknown order";
  }
  const contact = await senderContact(tap, order.shopId);
  if (!contact) {
    await db.insert(whatsappOrderActions).values({
      orderId: order.id,
      shopId: order.shopId,
      fromNumber: tap.from,
      action: tap.action,
      outcome: "REFUSED",
      detail: "Not a verified WhatsApp number of this order's shop.",
      inboundMessageId: tap.inboundId,
    });
    await reply(tap.from, order.shopId, order.id, `GoKesari: this WhatsApp number is not a verified number of the shop for order ${order.orderNumber}, so nothing was changed. Open the order in GoKesari: ${shopOrderLink(order.id)}`);
    return "refused: not a verified number of the shop";
  }
  const [owner] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, order.ownerId));
  const actor = { id: owner.id, role: owner.role };
  const [action] = await db
    .insert(whatsappOrderActions)
    .values({ orderId: order.id, shopId: order.shopId, contactId: contact.id, fromNumber: tap.from, action: tap.action, inboundMessageId: tap.inboundId })
    .returning({ id: whatsappOrderActions.id });
  const finish = (outcome: "DONE" | "ALREADY" | "ERROR", detail: string) =>
    db.update(whatsappOrderActions).set({ outcome, detail: detail.slice(0, 300), updatedAt: new Date() }).where(eq(whatsappOrderActions.id, action.id));

  try {
    if (tap.action === "ACCEPT") {
      await acceptOrder(order.id, actor);
      await finish("DONE", "Accepted");
      await reply(tap.from, order.shopId, order.id, `GoKesari: order ${order.orderNumber} is accepted. The customer has been told. Open it here to start packing: ${shopOrderLink(order.id)}`);
      return "accepted";
    }
    await rejectOrder(order.id, actor, WHATSAPP_REJECT_REASON, { onlyIfStatus: "CONFIRMED" });
    await finish("DONE", "Rejected");
    await reply(tap.from, order.shopId, order.id, `GoKesari: order ${order.orderNumber} is rejected ("${WHATSAPP_REJECT_REASON}"). The customer has been told and refunded in full, and the stock is back.`);
    return "rejected";
  } catch (error) {
    const [now] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.id));
    if (now && now.status !== "CONFIRMED" && now.status !== "PENDING") {
      const who = await whoDecided(order.id, action.id);
      const text = `GoKesari: order ${order.orderNumber} was already ${who.verb} by ${who.by} at ${who.at}. Nothing was changed.`;
      await finish("ALREADY", text);
      await reply(tap.from, order.shopId, order.id, text);
      return `already ${who.verb}`;
    }
    const message = error instanceof AppError ? error.message : "Something went wrong.";
    if (!(error instanceof AppError)) console.error("[whatsapp-shop-orders] button tap failed", tap, error);
    await finish("ERROR", message);
    await reply(
      tap.from,
      order.shopId,
      order.id,
      `GoKesari: order ${order.orderNumber} could not be ${tap.action === "ACCEPT" ? "accepted" : "rejected"}: ${message} Open it in GoKesari: ${shopOrderLink(order.id)}`,
    );
    return `error: ${message}`;
  }
}

/** Who took the order out of "waiting for the shop", and when — for "already accepted by … at …". */
export async function whoDecided(orderId: string, excludeActionId: string | null): Promise<{ verb: string; by: string; at: string }> {
  const [[order], [decision]] = await Promise.all([
    db.select({ userId: orders.userId }).from(orders).where(eq(orders.id, orderId)),
    db
      .select()
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.orderId, orderId), eq(orderStatusHistory.previousStatus, "CONFIRMED"), ne(orderStatusHistory.newStatus, "CONFIRMED")))
      .orderBy(asc(orderStatusHistory.createdAt))
      .limit(1),
  ]);
  if (!decision) return { verb: "handled", by: "someone else", at: formatIst(new Date()) };
  const cancelled = decision.newStatus === "CANCELLED" || decision.newStatus === "REFUND_PENDING" || decision.newStatus === "REFUNDED";
  const at = formatIst(decision.createdAt);
  if (cancelled && decision.changedBy && decision.changedBy === order?.userId) return { verb: "cancelled", by: "the customer", at };
  if (cancelled && !decision.changedBy) return { verb: "cancelled", by: "GoKesari (not accepted in time)", at };
  const verb = cancelled ? "rejected" : "accepted";

  // A WhatsApp tap that ran first (it may still be finishing): name that number.
  const taps = await db
    .select({
      createdAt: whatsappOrderActions.createdAt,
      id: whatsappOrderActions.id,
      outcome: whatsappOrderActions.outcome,
      contactId: whatsappOrderActions.contactId,
      fromNumber: whatsappOrderActions.fromNumber,
    })
    .from(whatsappOrderActions)
    .where(
      and(
        eq(whatsappOrderActions.orderId, orderId),
        eq(whatsappOrderActions.action, cancelled ? "REJECT" : "ACCEPT"),
        inArray(whatsappOrderActions.outcome, ["PENDING", "DONE"]),
        ...(excludeActionId ? [ne(whatsappOrderActions.id, excludeActionId)] : []),
      ),
    )
    .orderBy(asc(whatsappOrderActions.createdAt));
  // The tap that finished (DONE) is the winner; one still running counts only when none has finished.
  const started = taps.filter((t) => t.createdAt.getTime() <= decision.createdAt.getTime() + 1000);
  const first = started.find((t) => t.outcome === "DONE") ?? started[0];
  if (first) {
    const [contact] = first.contactId ? await db.select().from(shopWhatsappContacts).where(eq(shopWhatsappContacts.id, first.contactId)) : [];
    const number = formatIndianMobile(contact?.phoneE164 ?? first.fromNumber);
    return { verb, by: `${contact?.label ?? "the shop"} on WhatsApp (${number})`, at };
  }
  const [user] = decision.changedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, decision.changedBy)) : [];
  return { verb, by: `${user?.name?.trim() || "the shop"} in the GoKesari app`, at };
}

/** A free-form reply (the 24-hour window is open: the person just tapped). Logged; a failure is only logged. */
async function reply(to: string, shopId: string | null, orderId: string | null, text: string): Promise<void> {
  const [row] = await db
    .insert(whatsappMessages)
    .values({ shopId, orderId, kind: "REPLY", body: text, params: { text }, intendedTo: to, status: "SENDING", attempts: 1 })
    .returning({ id: whatsappMessages.id });
  try {
    const sent = await sendMetaText(to, text);
    await db
      .update(whatsappMessages)
      .set({ status: "SENT", metaMessageId: sent.messageId, sentTo: sent.sentTo, sentAt: new Date(), updatedAt: new Date() })
      .where(eq(whatsappMessages.id, row.id));
  } catch (error) {
    const err = error instanceof MetaWhatsAppError ? error : null;
    await db
      .update(whatsappMessages)
      .set({ status: "FAILED", error: (error instanceof Error ? error.message : String(error)).slice(0, 500), errorCode: err?.code ?? null, failedAt: new Date(), updatedAt: new Date() })
      .where(eq(whatsappMessages.id, row.id));
    console.warn("[whatsapp-shop-orders] reply failed", error instanceof Error ? error.message : error);
  }
}
