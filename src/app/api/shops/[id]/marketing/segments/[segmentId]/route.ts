/** Edit or delete one of the shop's segments (GS-052). Owner only. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopMarketing } from "@/server/authz/marketing-access";
import { deleteSegment, saveSegment } from "@/server/services/marketing";
import { rulesSchema } from "@/server/api/marketing-schemas";

const schema = z.object({ name: z.string().max(80), rules: rulesSchema });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; segmentId: string }>) => {
  const { id, segmentId } = await context.params;
  const user = await requireShopMarketing(id, "manage");
  const body = await parseBody(request, schema);
  return ok(await saveSegment(id, { id: segmentId, ...body }, user));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; segmentId: string }>) => {
  const { id, segmentId } = await context.params;
  const user = await requireShopMarketing(id, "manage");
  await deleteSegment(id, segmentId, user);
  return ok({ deleted: true });
});
