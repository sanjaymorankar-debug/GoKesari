/**
 * docs/flows-v3/wave2.md (flag flow_f16): the customer asks the shop to cancel a packed order.
 *   POST   { reason? } → the request (one open request per order)
 *   DELETE             → withdraws it while the shop has not answered
 * 404 while the flag is off.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requestCancellation, withdrawCancelRequest } from "@/server/flows/f16-cancellations";

export const dynamic = "force-dynamic";

const schema = z.object({ reason: z.string().max(300).nullish(), note: z.string().max(300).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  const body = await parseBody(request, schema);
  return ok(await requestCancellation(id, user, body.reason ?? body.note ?? null), 201);
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  await withdrawCancelRequest(id, user);
  return ok({ withdrawn: true });
});
