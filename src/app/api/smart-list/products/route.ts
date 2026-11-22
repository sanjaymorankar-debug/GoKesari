/** Product picker for a wishlist line: master catalogue products like the typed text (any language). */
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { searchProductsForList } from "@/server/services/smart-list/match";

export const dynamic = "force-dynamic";

export const GET = route(async (request: Request) => {
  const user = await requireUser();
  enforceRateLimit(`list-products:${user.id}`, RATE_LIMITS.SEARCH_SUGGEST);
  const { q } = parseQuery(request, z.object({ q: z.string().trim().min(1).max(80) }));
  return ok({ products: await searchProductsForList(q) });
});
