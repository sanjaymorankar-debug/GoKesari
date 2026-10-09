/** POST → reads items, stock and prices from the software now ("Sync now"). One pull at a time. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requestPull, requireIntegrationAccess } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "operate");
  enforceRateLimit(`integration-sync:${actor.id}`, { limit: 30, windowMs: 60 * 60_000 });
  return ok(await requestPull(id, "owner"), 202);
});
