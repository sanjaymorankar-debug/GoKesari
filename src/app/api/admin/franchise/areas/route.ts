/**
 * Admin area master (§5.1): GET the 196+ areas with their zones (Unzoned included).
 * PATCH { areaId, action: "remap", zoneId|null, reason }   move an area to another zone (or Unzoned), audited
 * PATCH { areaId, action: "location", lat, lng, pincodes }  the registration suggestion point and PIN codes
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireFranchiseAdmin, requireFranchiseReader } from "@/server/franchise/http";
import { listAreas, remapArea, updateAreaLocation } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireFranchiseReader();
  return ok({ areas: await listAreas({ includeTest: true }) });
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remap"), areaId: z.string().uuid(), zoneId: z.string().max(16).nullable(), reason: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal("location"), areaId: z.string().uuid(), lat: z.number(), lng: z.number(), pincodes: z.array(z.string()).max(20) }),
]);

export const PATCH = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, body);
  if (b.action === "remap") await remapArea(b.areaId, b.zoneId ? b.zoneId.toUpperCase() : null, b.reason, actor);
  else await updateAreaLocation(b.areaId, { lat: b.lat, lng: b.lng, pincodes: b.pincodes }, actor);
  return ok({ areaId: b.areaId });
});
