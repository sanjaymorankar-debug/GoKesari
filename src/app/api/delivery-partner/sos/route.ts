/**
 * Rider SOS (Rider App v2, rule riderSos).
 *   POST {latitude?, longitude?, accuracyM?} → {id, status, emergencyNumber, alreadyOpen}
 *        raises an SOS (or returns the rider's open one) and alerts operations.
 *   GET  → {enabled, emergencyNumber, event: {id, status, createdAt, acknowledgedAt} | null}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getMySosStatus, raiseSos } from "@/server/services/rider-sos";

export const dynamic = "force-dynamic";

const schema = z.object({
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  accuracyM: z.number().min(0).max(100_000).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  enforceRateLimit(`rider-sos:${user.id}`, { limit: 10, windowMs: 60_000 });
  const body = await parseBody(request, schema);
  return ok(await raiseSos(user, body), 201);
});

export const GET = route(async () => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN);
  return ok(await getMySosStatus(user.id));
});
