/** GET ?status=&q=&page= → the software's items and what each is matched to (mapping screen). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { itemListSchema, listItemLinks, requireIntegrationAccess } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  await requireIntegrationAccess(id, "view");
  return ok(await listItemLinks(id, parseQuery(request, itemListSchema)));
});
