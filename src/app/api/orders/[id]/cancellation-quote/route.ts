/**
 * F6.1.3 / F6.2.3 (batch-2026-10 WS-C): what cancelling this order now would
 * cost and refund — itemised — and where the refund can go. Shown to the
 * customer before they confirm. The buyer, the shop and support may ask;
 * anyone else gets 404.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { quoteCancellation } from "@/server/aftercare/cancellation";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  return ok(await quoteCancellation(id, user));
});
