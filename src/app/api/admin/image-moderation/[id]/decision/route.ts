/** F10: approve (goes live) or reject (with a reason) a product photo. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { moderateImage } from "@/server/services/product-images";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(300).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requirePermission(PERMISSIONS.PRODUCT_MANAGE);
  const row = await moderateImage(id, await parseBody(request, schema), user);
  return ok({ id: row.id, moderationStatus: row.moderationStatus });
});
