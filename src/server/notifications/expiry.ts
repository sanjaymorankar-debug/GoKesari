/**
 * batch-2026-10 WS-F (F3.3.2): a notification may carry `metadata.expiresAt`
 * (an ISO time — broadcasts set it from their expiry). Past that time it no
 * longer shows in the notification centre or counts as unread. Notifications
 * without it (everything that existed before) are unaffected.
 */
import { sql, type SQL } from "drizzle-orm";

import { notifications } from "@/server/db/schema";

export function notExpired(now?: Date): SQL {
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  return sql`(${notifications.metadata} ->> 'expiresAt' IS NULL OR (${notifications.metadata} ->> 'expiresAt')::timestamptz > ${at})`;
}
