/**
 * docs/flows-v3/wave2.md (flag flow_f16): the customer disagrees with a declined return — opens a dispute on the
 * order for the return's value, linked to the return. POST { description }. 404 while the flag is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { disputeDeclinedReturn } from "@/server/flows/f16-cancellations";

export const dynamic = "force-dynamic";

const schema = z.object({ description: z.string().trim().min(10, "Describe the problem in a little more detail.").max(2000) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  const body = await parseBody(request, schema);
  return ok(await disputeDeclinedReturn(id, user, body.description), 201);
});
