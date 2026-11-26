/**
 * Admin → Rider SOS (Rider App v2).
 *   GET ?status=OPEN|ACKNOWLEDGED|CLOSED → {events: [...]}, open first.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listSosEvents } from "@/server/services/rider-sos";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(["OPEN", "ACKNOWLEDGED", "CLOSED"]).optional() });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  const query = parseQuery(request, schema);
  return ok({ events: await listSosEvents({ status: query.status ?? null }) });
});
