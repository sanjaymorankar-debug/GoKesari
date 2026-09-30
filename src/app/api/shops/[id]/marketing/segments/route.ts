/**
 * A shop's customer segments (GS-052). GET lists them with audience counts
 * (never identities); POST creates one, or previews a rule set with
 * `{ preview: true }`.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireShopMarketing } from "@/server/authz/marketing-access";
import { rulesSchema } from "@/server/api/marketing-schemas";
import { listSegments, previewAudience, saveSegment } from "@/server/services/marketing";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  await requireShopMarketing(id, "view");
  return ok(await listSegments(id));
});

const schema = z.object({
  preview: z.boolean().optional(),
  name: z.string().max(80).optional(),
  rules: rulesSchema,
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  if (body.preview) {
    await requireShopMarketing(id, "view");
    return ok(await previewAudience(id, body.rules));
  }
  const user = await requireShopMarketing(id, "manage");
  return ok(await saveSegment(id, { name: body.name ?? "", rules: body.rules }, user), 201);
});
