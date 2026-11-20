/**
 * Admin: PATCH one zone —
 *   { action: "boundary", ref, shape, polygon?, radiusM?, note? }  save a DRAFT boundary (errors returned)
 *   { action: "approve" }                                          approve the latest draft (5 km, no overlap)
 *   { action: "status", status, reason }                           pause / resume / retire / needs split
 *   { action: "maxOwners", maxOwners, reason }                     1 or 2 (raising needs a super-admin)
 *   { action: "split", parts: [{ name, shops }], reason }          sub-zones 66-1, 66-2 …
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ZONE_STATUSES } from "@/lib/franchise";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireFranchiseAdmin } from "@/server/franchise/http";
import { approveBoundary, saveBoundaryDraft, setZoneMaxOwners, setZoneStatus, splitZone } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

const point = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("boundary"), ref: z.object({ lat: z.number(), lng: z.number(), label: z.string().max(200).nullish() }).nullable(), shape: z.enum(["POLYGON", "CIRCLE", "NONE"]), polygon: z.array(point).max(500).nullish(), radiusM: z.number().positive().max(50_000).nullish(), note: z.string().max(500).nullish() }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("status"), status: z.enum(ZONE_STATUSES), reason: z.string().min(5).max(300) }),
  z.object({ action: z.literal("maxOwners"), maxOwners: z.number().int(), reason: z.string().min(5).max(300) }),
  z.object({ action: z.literal("split"), parts: z.array(z.object({ name: z.string().min(1).max(200), shops: z.number().int().min(0) })).min(2).max(9), reason: z.string().min(5).max(300) }),
]);

export const PATCH = route(async (request: NextRequest, { params }: RouteContext<{ zoneId: string }>) => {
  const actor = await requireFranchiseAdmin();
  const zoneId = decodeURIComponent((await params).zoneId).toUpperCase();
  const b = await parseBody(request, body);
  switch (b.action) {
    case "boundary": {
      const r = await saveBoundaryDraft(zoneId, { ref: b.ref, shape: b.shape, polygon: b.polygon ?? null, radiusM: b.radiusM ?? null, note: b.note ?? null }, actor);
      return ok({ version: r.boundary.version, errors: r.errors });
    }
    case "approve":
      return ok(await approveBoundary(zoneId, actor));
    case "status":
      await setZoneStatus(zoneId, b.status, b.reason, actor);
      return ok({ zoneId, status: b.status });
    case "maxOwners":
      await setZoneMaxOwners(zoneId, b.maxOwners, b.reason, actor);
      return ok({ zoneId, maxOwners: b.maxOwners });
    case "split":
      return ok({ zoneIds: await splitZone(zoneId, b.parts, b.reason, actor) });
  }
});
