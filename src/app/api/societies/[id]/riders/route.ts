/** GS-045: add a rider to the society's authorised list by mobile number (society ADMIN). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { addSocietyRider } from "@/server/services/societies";

const schema = z.object({ mobile: z.string().min(10).max(15), preferred: z.boolean().default(false) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await addSocietyRider(id, body.mobile, body.preferred, user), 201);
});
