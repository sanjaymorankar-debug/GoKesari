/** Rate the help on a closed ticket, 1–5 with an optional comment (F6.3.3, batch-2026-10 WS-C). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { submitCsat } from "@/server/aftercare/support-tickets";

export const dynamic = "force-dynamic";

const schema = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(1000).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  const row = await submitCsat(id, user, await parseBody(request, schema));
  return ok({ rating: row.rating }, 201);
});
