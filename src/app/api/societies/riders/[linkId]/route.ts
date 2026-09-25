/** Revoke a listed rider (immediately) or toggle preferred (society ADMIN). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { updateSocietyRider } from "@/server/services/societies";

const schema = z.object({ revoke: z.boolean().optional(), preferred: z.boolean().optional() });

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ linkId: string }>) => {
  const user = await requireUser();
  const { linkId } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await updateSocietyRider(linkId, body, user));
});
