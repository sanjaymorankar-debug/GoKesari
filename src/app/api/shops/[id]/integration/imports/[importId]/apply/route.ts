/**
 * POST → applies the upload: 202 at once, the rows are matched and applied
 * after the response (GET the upload to see the result).
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { runItemImport, startItemImport } from "@/server/integrations/file-sync";

export const dynamic = "force-dynamic";

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string; importId: string }>) => {
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  const importId = z.string().uuid().parse(params.importId);
  const actor = await requireIntegrationAccess(id, "operate");
  await startItemImport(id, importId, actor);
  after(async () => {
    await runItemImport(importId).catch((error) => console.error("[integrations] file apply failed", error));
  });
  return ok({ importId, status: "APPLYING" }, 202);
});
