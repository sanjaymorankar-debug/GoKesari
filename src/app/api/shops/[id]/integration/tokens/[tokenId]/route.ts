/** DELETE → revokes a connector token; jobs it held go back to the queue. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess, revokeConnectorToken } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; tokenId: string }>) => {
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  const tokenId = z.string().uuid().parse(params.tokenId);
  const actor = await requireIntegrationAccess(id, "manage");
  await revokeConnectorToken(id, tokenId, actor);
  return noContent();
});
