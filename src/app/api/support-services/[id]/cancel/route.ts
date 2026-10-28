/**
 * POST { reason } — cancel a request: before payment, cancelled; paid but work not started, refunded
 * by the admin's percentage (wallet or the original payment); once work started, refused.
 * docs/dealer-programme, GKS-SP-001.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { cancelSupportRequest } from "@/server/services/support-services";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const body = await parseBody(request, z.object({ reason: z.string().max(300).default("") }));
  return ok({ request: await cancelSupportRequest(z.string().uuid().parse((await context.params).id), body.reason, user) });
});
