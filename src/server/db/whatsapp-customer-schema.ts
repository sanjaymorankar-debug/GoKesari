/**
 * Customer WhatsApp (docs/customer-whatsapp-2026-11/README.md; drizzle/0193_customer_whatsapp.sql).
 *
 *   whatsapp_customer_sessions  one chat per phone number: where the conversation
 *                               is (state), the last search results, the chat
 *                               cart, the PIN code used, the rate-limit window
 *                               and when the session expires
 *   whatsapp_cart_links         the cart behind a signed, short-lived,
 *                               single-use checkout link
 *
 * Messages themselves go through whatsapp_messages (kinds CUSTOMER_*). No
 * foreign keys to users: the service checks those links. Re-exported by schema.ts.
 */
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const WHATSAPP_SESSION_STATES = ["IDLE", "AWAIT_PIN", "PICK", "QTY"] as const;
export type WhatsAppSessionState = (typeof WHATSAPP_SESSION_STATES)[number];

/** One line of the chat cart (prices are re-read when the link is used). */
export interface WhatsAppCartLine {
  shopProductId: string;
  name: string;
  shopName: string;
  unitPricePaise: number;
  quantity: number;
}

/** A search result offered to pick from. */
export interface WhatsAppPickOption {
  shopProductId: string;
  name: string;
  shopName: string;
  unitPricePaise: number;
  /** "In stock" / "Out of stock" / "5 left". */
  availability: string;
  buyable: boolean;
}

export interface WhatsAppSessionContext {
  /** The search that waits for a PIN code. */
  pendingQuery?: string | null;
  /** The last search results (state PICK). */
  options?: WhatsAppPickOption[];
  /** The result picked, waiting for a quantity (state QTY). */
  picked?: WhatsAppPickOption | null;
  /** True once the "slow down" reply went out for the current window. */
  throttledNotice?: boolean;
}

export const whatsappCustomerSessions = pgTable(
  "whatsapp_customer_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneE164: text("phone_e164").notNull(),
    /** The customer whose verified number this is, when there is one. */
    userId: uuid("user_id"),
    state: text("state", { enum: WHATSAPP_SESSION_STATES }).notNull().default("IDLE"),
    context: jsonb("context").$type<WhatsAppSessionContext>().notNull().default({}),
    cart: jsonb("cart").$type<WhatsAppCartLine[]>().notNull().default([]),
    pincode: text("pincode"),
    /** STOP: no chat replies (and, for a known customer, no updates) until START. */
    optedOutAt: ts("opted_out_at"),
    windowStartedAt: ts("window_started_at").notNull().defaultNow(),
    windowCount: integer("window_count").notNull().default(0),
    lastInboundAt: ts("last_inbound_at"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("whatsapp_customer_sessions_phone_uq").on(t.phoneE164), index("whatsapp_customer_sessions_expires_idx").on(t.expiresAt)],
);

export const whatsappCartLinks = pgTable(
  "whatsapp_cart_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id"),
    phoneE164: text("phone_e164").notNull(),
    /** The customer the chat belonged to (null for a number with no account yet). */
    userId: uuid("user_id"),
    lines: jsonb("lines").$type<WhatsAppCartLine[]>().notNull().default([]),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    usedBy: uuid("used_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("whatsapp_cart_links_phone_idx").on(t.phoneE164, t.createdAt)],
);

export type WhatsappCustomerSession = typeof whatsappCustomerSessions.$inferSelect;
export type WhatsappCartLink = typeof whatsappCartLinks.$inferSelect;
