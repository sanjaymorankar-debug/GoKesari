/** In-app notifications for the signed-in user (§49). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from "@/server/services/notifications";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const unreadOnly =
    new URL(request.url).searchParams.get("unreadOnly") === "true";

  const [items, unread] = await Promise.all([
    listNotifications(user.id, { unreadOnly }),
    unreadCount(user.id),
  ]);
  return ok({ notifications: items, unreadCount: unread });
});

const schema = z.object({ id: z.string().uuid().optional(), all: z.boolean().optional() });

export const PATCH = route(async (request: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(request, schema);

  if (body.all) await markAllRead(user.id);
  // TC-NTF-012: an id that is not the caller's notification is a 404, not a silent 200.
  else if (body.id && !(await markRead(user.id, body.id))) throw notFound("Notification");

  return ok({ unreadCount: await unreadCount(user.id) });
});
