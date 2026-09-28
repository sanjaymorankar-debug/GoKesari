/** Hide or restore a rating (moderation). RATING_MODERATE — operator/admin. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { moderateRating } from "@/server/services/ratings";

const schema = z.object({ hide: z.boolean(), reason: z.string().max(300).default("") });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.RATING_MODERATE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await moderateRating(id, body.hide, body.reason, user));
});
