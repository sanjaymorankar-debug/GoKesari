/**
 * Event layer: write on a dispute case — the customer, the shop or support
 * (support may also leave an internal note). The other parties are notified
 * at once. `clientRequestId` makes a double-tapped "Send" post once.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { addDisputeComment } from "@/server/services/disputes";

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({
  body: z.string().min(2).max(2000),
  internal: z.boolean().optional(),
  imageIds: z.array(z.string().uuid()).max(6).optional(),
  clientRequestId: z.string().min(8).max(100),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`dispute-comment:${user.id}`, RATE_LIMITS.MUTATION);
  const { id } = paramsSchema.parse(await context.params);
  const body = await parseBody(request, bodySchema);
  return ok(await addDisputeComment(id, body, user), 201);
});
