/** GET → an upload (headings, sample, mapping, result). DELETE → cancels it if not applied. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, route, type RouteContext } from "@/server/api/handler";
import { requireIntegrationAccess } from "@/server/integrations/connections";
import { cancelItemImport, getItemImport } from "@/server/integrations/file-sync";

export const dynamic = "force-dynamic";

type Params = { id: string; importId: string };

export const GET = route(async (_request: NextRequest, context: RouteContext<Params>) => {
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  await requireIntegrationAccess(id, "view");
  return ok(await getItemImport(id, z.string().uuid().parse(params.importId)));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<Params>) => {
  const params = await context.params;
  const id = z.string().uuid().parse(params.id);
  await requireIntegrationAccess(id, "operate");
  await cancelItemImport(id, z.string().uuid().parse(params.importId));
  return noContent();
});
