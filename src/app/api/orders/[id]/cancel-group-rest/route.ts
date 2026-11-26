/**
 * docs/flows-v3/wave2.md (flag flow_f20): after one shop of a multi-shop checkout declined its part, the customer
 * cancels the other parts still cancellable (each by the customer's own cancel path). 404 while the flag is off.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { cancelRemainingGroupOrders } from "@/server/flows/f20-multishop";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  return ok(await cancelRemainingGroupOrders(id, user));
});
