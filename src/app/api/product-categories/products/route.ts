/** Every product in the catalogue, searchable and filterable by category. GET ?q=&categoryId=&offset= */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { browseCatalogue } from "@/server/services/product-categories";

export const dynamic = "force-dynamic";

const schema = z.object({
  q: z.string().max(100).optional(),
  categoryId: z.string().uuid().optional(),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.CATALOGUE_BROWSE);
  const { q, categoryId, offset } = parseQuery(request, schema);
  return ok(await browseCatalogue({ query: q, categoryId, offset, limit: 50 }));
});
