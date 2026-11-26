/** Revoke a listed rider (immediately) or toggle preferred (society ADMIN). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { updateSocietyRider } from "@/server/services/societies";

const schema = z.object({
  revoke: z.boolean().optional(),
  preferred: z.boolean().optional(),
  // docs/flows-v3/wave5.md (flag flow_f15): pause the rider here for some days, or end a pause.
  suspendDays: z.number().int().min(1).max(365).optional(),
  suspendReason: z.string().max(300).nullish(),
  resume: z.boolean().optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ linkId: string }>) => {
  const user = await requireUser();
  const { linkId } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await updateSocietyRider(linkId, body, user));
});
