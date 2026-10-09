/** POST → disconnects: secrets deleted, connector tokens revoked, unsent entries cancelled. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { disconnectIntegration, requireIntegrationAccess } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "manage");
  await disconnectIntegration(id, actor);
  return noContent();
});
