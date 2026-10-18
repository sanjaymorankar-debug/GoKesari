/**
 * F3.3.2: the Notification Centre — the bell's panel and the /notifications
 * page, on the website and in the app (the same pages). Read/unread is per
 * person (notifications.read_at); expired broadcasts are left out.
 */
import { and, count, desc, eq, isNull } from "drizzle-orm";

import { db } from "@/server/db";
import { notifications, type Notification } from "@/server/db/schema";
import { notExpired } from "./expiry";

export type CentreFilter = "all" | "unread";

export interface CentreItem {
  id: string;
  type: string;
  title: string;
  body: string;
  /** A safe link (in-site path or https) or null. */
  actionUrl: string | null;
  imageUrl: string | null;
  read: boolean;
  createdAt: string;
}

export interface CentrePage {
  items: CentreItem[];
  total: number;
  unread: number;
  page: number;
  pageCount: number;
}

/** Only an in-site path ("/orders/1", never "//elsewhere") or an https URL is followed. */
export function safeActionUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const value = url.trim();
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return value;
  if (/^https:\/\/[^\s/]+/i.test(value)) return value;
  return null;
}

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\/api\/images\/[0-9a-f-]{36}(\?size=(thumb|medium|large))?$/i.test(value)) return value;
  if (/^https:\/\/[^\s"'<>]+$/i.test(value)) return value;
  return null;
}

export function toCentreItem(n: Notification): CentreItem {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    actionUrl: safeActionUrl(n.actionUrl),
    imageUrl: safeImageUrl(n.metadata?.imageUrl),
    read: Boolean(n.readAt),
    createdAt: n.createdAt.toISOString(),
  };
}

export async function listNotificationCentre(
  userId: string,
  options: { filter?: CentreFilter; page?: number; pageSize?: number } = {},
): Promise<CentrePage> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 20, 1), 100);
  const base = and(eq(notifications.userId, userId), eq(notifications.channel, "IN_APP"), notExpired());
  const unreadWhere = and(base, isNull(notifications.readAt));
  const where = options.filter === "unread" ? unreadWhere : base;

  const [[{ value: total }], [{ value: unread }]] = await Promise.all([
    db.select({ value: count() }).from(notifications).where(where),
    db.select({ value: count() }).from(notifications).where(unreadWhere),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(options.page ?? 1), 1), pageCount);
  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: rows.map(toCentreItem), total, unread, page, pageCount };
}

/** One of the person's own notifications (null for someone else's or an expired one). */
export async function getOwnNotification(userId: string, id: string): Promise<Notification | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId), notExpired()));
  return row ?? null;
}
