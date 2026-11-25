/** Admin → Rider SOS: POST → acknowledge an OPEN SOS; the rider is told help is on the way. */
import type { NextRequest } from "next/server";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { acknowledgeSos } from "@/server/services/rider-sos";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("SOS");
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  enforceRateLimit(`admin-rider-sos:${user.id}`, RATE_LIMITS.MUTATION);
  const event = await acknowledgeSos(id, user);
  return ok({ id: event.id, status: event.status, acknowledgedAt: event.acknowledgedAt });
});
