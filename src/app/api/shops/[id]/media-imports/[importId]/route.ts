/** One bulk upload (Module 1): GET its preview or progress; DELETE cancels it before it is applied. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { noContent, ok, route, type RouteContext } from "@/server/api/handler";
import { cancelMediaImport, getMediaImport } from "@/server/services/shop-media-import";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), importId: z.string().uuid() });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string; importId: string }>) => {
  const { id, importId } = ids.parse(await context.params);
  await requireShopCatalogueAccess(id);
  return ok(await getMediaImport(id, importId));
});

export const DELETE = route(async (_request: NextRequest, context: RouteContext<{ id: string; importId: string }>) => {
  const { id, importId } = ids.parse(await context.params);
  await requireShopCatalogueAccess(id);
  await cancelMediaImport(id, importId);
  return noContent();
});
