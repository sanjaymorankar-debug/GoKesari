/** Add or remove a shop the society recommends to its residents (society ADMIN). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { setSocietyShop } from "@/server/services/societies";

const schema = z.object({ shopId: z.string().uuid(), active: z.boolean() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await setSocietyShop(id, body.shopId, body.active, user));
});
