/**
 * Admin zone status (§5.6). Operators may read; only an admin changes.
 *   GET ?zoneId=                       status history (and pending scheduled changes)
 *   POST { zoneIds, status, reason, reservedForDealerId?, reservedUntil?, scheduledFor? }  one or many zones; a future
 *        scheduledFor (ISO, shown in IST) schedules it; Sold Out is the system's only.
 *   DELETE ?id=                        cancel a scheduled change not yet applied
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ADMIN_ZONE_STATUSES } from "@/lib/franchise";
import { ok, parseBody, parseQuery, route } from "@/server/api/handler";
import { requireFranchiseAdmin, requireFranchiseReader } from "@/server/franchise/http";
import { cancelScheduledStatus, changeZoneStatus, zoneStatusHistory } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireFranchiseReader();
  const q = parseQuery(request, z.object({ zoneId: z.string().max(16).optional() }));
  return ok({ history: await zoneStatusHistory(q.zoneId, 500) });
});

const body = z.object({
  zoneIds: z.array(z.string().trim().min(1).max(16)).min(1).max(200),
  status: z.enum(ADMIN_ZONE_STATUSES),
  reason: z.string().trim().min(5).max(500),
  reservedForDealerId: z.string().uuid().nullish(),
  reservedUntil: z.coerce.date().nullish(),
  scheduledFor: z.coerce.date().nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, body);
  return ok(await changeZoneStatus(b.zoneIds.map((z) => z.toUpperCase()), { status: b.status, reason: b.reason, reservedForDealerId: b.reservedForDealerId ?? null, reservedUntil: b.reservedUntil ?? null, scheduledFor: b.scheduledFor ?? null }, actor));
});

export const DELETE = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const q = parseQuery(request, z.object({ id: z.string().uuid() }));
  await cancelScheduledStatus(q.id, actor);
  return ok({ cancelled: q.id });
});
