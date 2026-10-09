/** PUT { mapping: { name: "Item Name", stock: "Qty", … } } → saves the columns (and remembers them for next time). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { mappingSchema, setImportMapping } from "@/server/integrations/file-sync";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string; importId: string }>) => {
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  const actor = await requireIntegrationAccess(id, "operate");
  const { mapping } = await parseBody(request, z.object({ mapping: mappingSchema }));
  return ok(await setImportMapping(id, z.string().uuid().parse(params.importId), mapping, actor));
});
