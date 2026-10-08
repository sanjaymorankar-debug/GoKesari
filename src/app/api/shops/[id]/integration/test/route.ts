/** POST → tests the connection now (API software), or sends a test to the Tally connector. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireIntegrationAccess, testIntegration } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "operate");
  enforceRateLimit(`integration-test:${actor.id}`, { limit: 20, windowMs: 10 * 60_000 });
  return ok(await testIntegration(id));
});
