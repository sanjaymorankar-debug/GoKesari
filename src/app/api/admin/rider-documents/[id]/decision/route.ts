/** C5: an admin accepts or rejects one rider identity document. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { decideRiderDocument } from "@/server/services/rider-files";

const schema = z.object({
  decision: z.enum(["ACCEPTED", "REJECTED"]),
  reason: z.string().max(300).nullish(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireRole("ADMIN");
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok({ document: await decideRiderDocument(id, body.decision, body.reason ?? null, user) });
});
