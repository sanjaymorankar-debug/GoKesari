/** Waive a pending shop's registration fee (admin only), with a reason. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { waiveRegistrationFee } from "@/server/services/shop-payments";

const schema = z.object({ reason: z.string().trim().min(10).max(500) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const id = z.string().uuid().parse((await context.params).id);
  const { reason } = await parseBody(request, schema);
  return ok(await waiveRegistrationFee(id, reason, user));
});
