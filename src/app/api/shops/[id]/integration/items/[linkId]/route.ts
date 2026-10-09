/**
 * PATCH { action: "match", productId } | { action: "ignore" } | { action: "unmatch" }
 * A match is applied at once (stock, price, tax from the software's last values).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { itemActionSchema, requireIntegrationAccess, updateItemLink } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string; linkId: string }>) => {
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  const linkId = z.string().uuid().parse(params.linkId);
  const actor = await requireIntegrationAccess(id, "operate");
  const input = await parseBody(request, itemActionSchema);
  return ok(await updateItemLink(id, linkId, input, actor));
});
