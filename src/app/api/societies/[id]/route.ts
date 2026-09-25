/**
 * One society. GET — dashboard (society ADMIN/OPERATOR, or platform staff).
 * PATCH — rules and instructions (society ADMIN, or platform staff).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getSocietyDashboard, updateSocietySettings } from "@/server/services/societies";

const schema = z.object({
  deliveryInstructions: z.string().max(500).nullish(),
  securityNotifyEnabled: z.boolean().optional(),
  exclusiveRiders: z.boolean().optional(),
  boundaryRadiusMeters: z.number().int().min(50).max(3000).optional(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  return ok(await getSocietyDashboard(id, user));
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await updateSocietySettings(id, body, user));
});
