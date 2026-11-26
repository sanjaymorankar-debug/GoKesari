/** Admin → Rider SOS: POST {note} → close an SOS with a note. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { closeSos } from "@/server/services/rider-sos";

export const dynamic = "force-dynamic";

const schema = z.object({ note: z.string().max(2000) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("SOS");
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  enforceRateLimit(`admin-rider-sos:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, schema);
  const event = await closeSos(id, body.note, user);
  return ok({ id: event.id, status: event.status, closedAt: event.closedAt });
});
