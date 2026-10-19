/**
 * One broadcast (F3.3.2) — admin and operator (BROADCAST_MANAGE).
 *   GET   → the broadcast with recipient and read counts
 *   PATCH { title, message, imageUrl?, linkUrl?, audience, scheduleAt?, expiresAt? } → change a draft / scheduled one
 *   POST  { action: "send" }                      → send now (chunked; the dispatcher finishes big audiences)
 *         { action: "schedule", scheduleAt }      → send at that time (cron broadcast-dispatch)
 *         { action: "cancel" }                    → stop a draft, scheduled or sending broadcast
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import {
  cancelBroadcast,
  getBroadcast,
  scheduleBroadcast,
  sendBroadcastNow,
  updateBroadcast,
} from "@/server/services/broadcasts";

export const dynamic = "force-dynamic";

type Ctx = RouteContext<{ id: string }>;

export const GET = route(async (_request: NextRequest, context: Ctx) => {
  await requirePermission(PERMISSIONS.BROADCAST_MANAGE);
  const { id } = await context.params;
  return ok({ broadcast: await getBroadcast(id) });
});

export const PATCH = route(async (request: NextRequest, context: Ctx) => {
  const user = await requirePermission(PERMISSIONS.BROADCAST_MANAGE);
  enforceRateLimit(`broadcast:${user.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  const body = await parseBody(request, z.unknown());
  return ok({ broadcast: await updateBroadcast(user, id, body) });
});

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send") }),
  z.object({ action: z.literal("schedule"), scheduleAt: z.coerce.date() }),
  z.object({ action: z.literal("cancel") }),
]);

export const POST = route(async (request: NextRequest, context: Ctx) => {
  const user = await requirePermission(PERMISSIONS.BROADCAST_MANAGE);
  enforceRateLimit(`broadcast:${user.id}`, RATE_LIMITS.MUTATION);
  const { id } = await context.params;
  const body = await parseBody(request, actionSchema);
  const broadcast =
    body.action === "send"
      ? await sendBroadcastNow(user, id)
      : body.action === "schedule"
        ? await scheduleBroadcast(user, id, body.scheduleAt)
        : await cancelBroadcast(user, id);
  return ok({ broadcast });
});
