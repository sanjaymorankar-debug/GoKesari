/** GET ?q= → GoKesari products to match an item to (name, code or barcode). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess, searchProductsForMapping } from "@/server/integrations/connections";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  await requireIntegrationAccess(id, "operate");
  const { q } = parseQuery(request, z.object({ q: z.string().trim().max(100).default("") }));
  return ok({ products: await searchProductsForMapping(id, q) });
});
