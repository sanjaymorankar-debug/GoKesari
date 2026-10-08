/** POST → runs automatic matching again on items not matched by hand. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { rematchItems, requireIntegrationAccess } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "operate");
  enforceRateLimit(`integration-rematch:${actor.id}`, { limit: 10, windowMs: 10 * 60_000 });
  return ok(await rematchItems(id));
});
