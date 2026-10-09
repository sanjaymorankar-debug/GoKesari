/**
 * GET ?kind=invoices|credit-notes|stock-out&scope=new|range&from=&to=&format=xlsx|csv
 * File sync: GoKesari sales to import into the shop's software. "new" takes
 * what was not downloaded before and marks it; "range" marks nothing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { exportDocuments, exportQuerySchema } from "@/server/integrations/file-sync";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  const actor = await requireIntegrationAccess(id, "operate");
  enforceRateLimit(`integration-export:${actor.id}`, { limit: 60, windowMs: 60 * 60_000 });
  const file = await exportDocuments(id, parseQuery(request, exportQuerySchema), actor);
  return new NextResponse(new Uint8Array(file.body), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "cache-control": "no-store",
      "x-document-count": String(file.count),
    },
  });
});
