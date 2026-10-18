/**
 * Broadcast announcements (F3.3.2) — admin and operator (BROADCAST_MANAGE).
 *   GET  ?status=DRAFT|SCHEDULED|SENDING|SENT|CANCELLED|EXPIRED → list with recipient and read counts
 *   POST { title, message, imageUrl?, linkUrl?, audience, scheduleAt?, expiresAt?, action: draft|schedule|send }
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { BROADCAST_STATUSES } from "@/server/db/schema";
import { createBroadcast, listBroadcasts } from "@/server/services/broadcasts";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.BROADCAST_MANAGE);
  const raw = new URL(request.url).searchParams.get("status");
  const status = BROADCAST_STATUSES.find((s) => s === raw);
  return ok({ broadcasts: await listBroadcasts({ status }) });
});

const bodySchema = z.object({ action: z.enum(["draft", "schedule", "send"]).default("draft") }).passthrough();

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.BROADCAST_MANAGE);
  enforceRateLimit(`broadcast:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, bodySchema);
  const broadcast = await createBroadcast(user, body, body.action);
  return ok({ broadcast }, 201);
});
