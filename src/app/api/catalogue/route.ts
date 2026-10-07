/** Categories and master products, by department (§7). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { listCategories, listProducts } from "@/server/services/catalogue";
import type { Department } from "@/server/db/schema";

export const dynamic = "force-dynamic";

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(async (request: NextRequest) => {
  const p = new URL(request.url).searchParams;
  const department = (p.get("department") as Department | null) ?? undefined;
  // Products come `limit` at a time; categories are a short list, sent whole.
  const { limit, offset } = parseQuery(request, pageSchema);

  const [categories, catalogue] = await Promise.all([
    listCategories(department),
    listProducts({
      department,
      categoryId: p.get("categoryId") ?? undefined,
      subscribableOnly: p.get("subscribable") === "true",
      limit,
      offset,
    }),
  ]);
  return ok({ categories, products: catalogue });
});
