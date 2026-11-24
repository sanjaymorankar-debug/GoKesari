/**
 * New orders on the shop owner's WhatsApp (docs/smart-shopping-2026-11/
 * FEATURE3_WHATSAPP_ORDERS.md; drizzle/0169_whatsapp_shop_orders.sql).
 *
 *   shop_whatsapp_settings   the shop's own on/off (the owner's choice)
 *   shop_whatsapp_contacts   the numbers that get order alerts: the owner's
 *                            (prefilled with the shop's WhatsApp number) and up
 *                            to N staff numbers; each is checked with a test
 *                            template before it gets orders
 *   whatsapp_messages        the outbox and the message log: one row per message
 *                            per number, its Meta id and its sent / delivered /
 *                            read / failed status
 *   whatsapp_webhook_events  every webhook item handled once (Meta retries)
 *   whatsapp_order_actions   Accept / Reject taps and what came of them
 *
 * The SQL gives the shop-side tables a foreign key to shops (seller side,
 * ON DELETE CASCADE); orders and users are not referenced by key (the
 * service checks those links). Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";


const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const WHATSAPP_CONTACT_STATUSES = ["UNCHECKED", "CHECKING", "ACTIVE", "NOT_ON_WHATSAPP"] as const;
export type WhatsAppContactStatus = (typeof WHATSAPP_CONTACT_STATUSES)[number];

/** CUSTOMER_* (0193, docs/customer-whatsapp-2026-11): template updates to customers and chat replies to them. */
export const WHATSAPP_MESSAGE_KINDS = ["NEW_ORDER", "STATUS_UPDATE", "NUMBER_CHECK", "REPLY", "CUSTOMER_NOTIFICATION", "CUSTOMER_REPLY"] as const;
export type WhatsAppMessageKind = (typeof WHATSAPP_MESSAGE_KINDS)[number];

export const WHATSAPP_MESSAGE_STATUSES = ["QUEUED", "SENDING", "SENT", "DELIVERED", "READ", "FAILED", "SKIPPED"] as const;
export type WhatsAppMessageStatus = (typeof WHATSAPP_MESSAGE_STATUSES)[number];

/** One row per shop that has opened its WhatsApp settings. No row = off. */
export const shopWhatsappSettings = pgTable("shop_whatsapp_settings", {
  shopId: uuid("shop_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  updatedBy: uuid("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const shopWhatsappContacts = pgTable(
  "shop_whatsapp_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    /** E.164, e.g. +919876543210. */
    phoneE164: text("phone_e164").notNull(),
    role: text("role", { enum: ["OWNER", "STAFF"] }).notNull(),
    /** Shown in "accepted by …": the owner's or staff member's name. */
    label: text("label"),
    /** The person agreed to get order alerts on this number. */
    optedIn: boolean("opted_in").notNull().default(true),
    status: text("status", { enum: WHATSAPP_CONTACT_STATUSES }).notNull().default("UNCHECKED"),
    /** The NUMBER_CHECK message (whatsapp_messages.id) whose status decides `status`. */
    checkMessageId: uuid("check_message_id"),
    checkSentAt: ts("check_sent_at"),
    /** Delivered (or read) at: the number is on WhatsApp. */
    verifiedAt: ts("verified_at"),
    lastError: text("last_error"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    removedAt: ts("removed_at"),
  },
  (t) => [
    uniqueIndex("shop_whatsapp_contacts_live_uq").on(t.shopId, t.phoneE164).where(sql`${t.removedAt} IS NULL`),
    index("shop_whatsapp_contacts_phone_idx").on(t.phoneE164),
  ],
);

export const whatsappMessages = pgTable(
  "whatsapp_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id"),
    orderId: uuid("order_id"),
    contactId: uuid("contact_id"),
    /** 0185: the customer a CUSTOMER_* message is for (no foreign key; the service checks it). */
    userId: uuid("user_id"),
    kind: text("kind", { enum: WHATSAPP_MESSAGE_KINDS }).notNull(),
    /** The domain event that queued it (order.placed, order.assigned …), if any. */
    eventType: text("event_type"),
    /** Template name for a template send; null for a free-form reply. */
    template: text("template"),
    /** Template parameters (or the reply text) as sent. */
    params: jsonb("params").$type<Record<string, unknown>>(),
    /** Readable copy of what was sent, for the log page. */
    body: text("body"),
    /** The number the message was for. */
    intendedTo: text("intended_to").notNull(),
    /** The number it actually went to (the test recipient on test.gokesari.com). */
    sentTo: text("sent_to"),
    status: text("status", { enum: WHATSAPP_MESSAGE_STATUSES }).notNull().default("QUEUED"),
    metaMessageId: text("meta_message_id"),
    errorCode: text("error_code"),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    /** At most one message per key (event × number). */
    dedupeKey: text("dedupe_key"),
    /** Messages of one event: the fallback goes out once per group. */
    groupKey: text("group_key"),
    fallbackAt: ts("fallback_at"),
    sentAt: ts("sent_at"),
    deliveredAt: ts("delivered_at"),
    readAt: ts("read_at"),
    failedAt: ts("failed_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("whatsapp_messages_meta_id_uq").on(t.metaMessageId),
    uniqueIndex("whatsapp_messages_dedupe_uq").on(t.dedupeKey),
    index("whatsapp_messages_queue_idx").on(t.status, t.createdAt),
    index("whatsapp_messages_shop_idx").on(t.shopId, t.createdAt),
    index("whatsapp_messages_order_idx").on(t.orderId),
    index("whatsapp_messages_created_idx").on(t.createdAt),
    index("whatsapp_messages_user_idx").on(t.userId, t.createdAt),
  ],
);

export const whatsappWebhookEvents = pgTable(
  "whatsapp_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** msg:<wamid> for an incoming message, status:<wamid>:<status> for a status update. */
    eventKey: text("event_key").notNull(),
    kind: text("kind", { enum: ["MESSAGE", "STATUS"] }).notNull(),
    fromNumber: text("from_number"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    result: text("result"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("whatsapp_webhook_events_key_uq").on(t.eventKey), index("whatsapp_webhook_events_created_idx").on(t.createdAt)],
);

export const whatsappOrderActions = pgTable(
  "whatsapp_order_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull(),
    shopId: uuid("shop_id"),
    contactId: uuid("contact_id"),
    fromNumber: text("from_number").notNull(),
    action: text("action", { enum: ["ACCEPT", "REJECT"] }).notNull(),
    /** PENDING while running; DONE = this tap decided the order; ALREADY = someone was first; REFUSED / ERROR otherwise. */
    outcome: text("outcome", { enum: ["PENDING", "DONE", "ALREADY", "REFUSED", "ERROR"] }).notNull().default("PENDING"),
    detail: text("detail"),
    inboundMessageId: text("inbound_message_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("whatsapp_order_actions_order_idx").on(t.orderId, t.createdAt)],
);

export type ShopWhatsappContact = typeof shopWhatsappContacts.$inferSelect;
export type WhatsappMessage = typeof whatsappMessages.$inferSelect;
