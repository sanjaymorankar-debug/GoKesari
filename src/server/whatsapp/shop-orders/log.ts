/**
 * The WhatsApp message log for admins and operators (/admin/whatsapp-messages):
 * every message with its Meta id, status and error, with filters, and the
 * delivery figures per IST day (docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md).
 */
import { and, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/server/db";
import { orders, shops, whatsappMessages, WHATSAPP_MESSAGE_KINDS, WHATSAPP_MESSAGE_STATUSES, type WhatsAppMessageKind, type WhatsAppMessageStatus } from "@/server/db/schema";

export interface WhatsAppLogFilters {
  status?: WhatsAppMessageStatus;
  kind?: WhatsAppMessageKind;
  /** Part of a number (intended or actual recipient). */
  number?: string;
  /** Part of a shop name. */
  shop?: string;
  /** Order number, exact or partial. */
  order?: string;
  /** YYYY-MM-DD, IST. */
  from?: string;
  to?: string;
  limit?: number;
}

export function parseLogFilters(params: Record<string, string | string[] | undefined>): WhatsAppLogFilters {
  const one = (key: string) => {
    const v = params[key];
    const s = (Array.isArray(v) ? v[0] : v)?.trim();
    return s ? s : undefined;
  };
  const date = (key: string) => {
    const v = one(key);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  };
  const status = one("status");
  const kind = one("kind");
  return {
    status: (WHATSAPP_MESSAGE_STATUSES as readonly string[]).includes(status ?? "") ? (status as WhatsAppMessageStatus) : undefined,
    kind: (WHATSAPP_MESSAGE_KINDS as readonly string[]).includes(kind ?? "") ? (kind as WhatsAppMessageKind) : undefined,
    number: one("number")?.replace(/[^\d+]/g, "") || undefined,
    shop: one("shop")?.slice(0, 80),
    order: one("order")?.slice(0, 40),
    from: date("from"),
    to: date("to"),
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listWhatsAppMessages(filters: WhatsAppLogFilters) {
  const where: SQL[] = [];
  if (filters.status) where.push(eq(whatsappMessages.status, filters.status));
  if (filters.kind) where.push(eq(whatsappMessages.kind, filters.kind));
  if (filters.number) {
    const like = `%${escapeLike(filters.number)}%`;
    where.push(or(ilike(whatsappMessages.intendedTo, like), ilike(whatsappMessages.sentTo, like))!);
  }
  if (filters.shop) where.push(ilike(shops.name, `%${escapeLike(filters.shop)}%`));
  if (filters.order) where.push(ilike(orders.orderNumber, `%${escapeLike(filters.order)}%`));
  if (filters.from) where.push(gte(whatsappMessages.createdAt, sql`(${filters.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`));
  if (filters.to) where.push(lte(whatsappMessages.createdAt, sql`((${filters.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`));
  return db
    .select({
      message: whatsappMessages,
      shopName: shops.name,
      orderNumber: orders.orderNumber,
    })
    .from(whatsappMessages)
    .leftJoin(shops, eq(shops.id, whatsappMessages.shopId))
    .leftJoin(orders, eq(orders.id, whatsappMessages.orderId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(Math.min(filters.limit ?? 200, 500));
}

export interface WhatsAppDayStats {
  day: string;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  total: number;
}

/**
 * Per IST day, by the state each message reached: "sent" counts every message
 * Meta accepted (also those later delivered / read), "delivered" includes read.
 */
export async function whatsAppDailyStats(days = 14): Promise<WhatsAppDayStats[]> {
  const rows = await db.execute<{
    day: string;
    queued: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    skipped: number;
    total: number;
  }>(sql`
    SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE status IN ('QUEUED', 'SENDING'))::int AS queued,
           count(*) FILTER (WHERE status IN ('SENT', 'DELIVERED', 'READ') OR (status = 'FAILED' AND meta_message_id IS NOT NULL))::int AS sent,
           count(*) FILTER (WHERE status IN ('DELIVERED', 'READ'))::int AS delivered,
           count(*) FILTER (WHERE status = 'READ')::int AS read,
           count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
           count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
           count(*)::int AS total
    FROM whatsapp_messages
    WHERE created_at >= now() - make_interval(days => ${days})
    GROUP BY 1
    ORDER BY 1 DESC
  `);
  return [...rows].map((r) => ({
    day: String(r.day),
    queued: Number(r.queued),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    read: Number(r.read),
    failed: Number(r.failed),
    skipped: Number(r.skipped),
    total: Number(r.total),
  }));
}
