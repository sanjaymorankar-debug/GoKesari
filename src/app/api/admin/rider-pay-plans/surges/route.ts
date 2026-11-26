/** Manual pay surges (rain, festival, event) for a city or a zone: list, and start one. */
import type { NextRequest } from "next/server";

import { toSurgeRow } from "@/components/admin/rider-pay-plans/serialize";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listSurges, startSurge } from "@/server/services/rider-pay-plans";

import { surgeSchema } from "../schemas";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const surges = await listSurges();
  return ok({ surges: surges.map((s) => ({ ...toSurgeRow(s), live: s.live })) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const body = await parseBody(request, surgeSchema);
  const saved = await startSurge(
    {
      city: body.city ?? null,
      zoneId: body.zoneId ?? null,
      multiplierBp: body.multiplierBp,
      flatPaise: body.flatPaise,
      reason: body.reason,
      note: body.note ?? null,
      startsAt: body.startsAt ? new Date(body.startsAt) : null,
      endsAt: new Date(body.endsAt),
    },
    user,
  );
  return ok({ surge: toSurgeRow(saved) }, 201);
});
