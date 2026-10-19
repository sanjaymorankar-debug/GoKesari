/**
 * Notification Centre for the signed-in person (F3.3.2) — the bell's panel and
 * /notifications, on the website and in the app.
 *   GET ?filter=all|unread&page=1&pageSize=20 → { items, total, unread, page, pageCount }
 * Read state: PATCH /api/notifications { id } or { all: true } (existing).
 * Expired broadcasts are not listed and do not count as unread.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listNotificationCentre } from "@/server/notifications/centre";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  filter: z.enum(["all", "unread"]).default("all"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const query = parseQuery(request, querySchema);
  return ok(await listNotificationCentre(user.id, query));
});
