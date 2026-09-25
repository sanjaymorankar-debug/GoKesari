/** Public shop rating: aggregate + recent visible reviews (no customer identity). */
import { eq } from "drizzle-orm";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { listShopReviews } from "@/server/services/ratings";

export const GET = route(async (_request: Request, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, id), columns: { id: true, status: true, ratingAvgX100: true, ratingCount: true } });
  if (!shop || shop.status !== "APPROVED") throw notFound("Shop");
  return ok({
    average: shop.ratingCount ? shop.ratingAvgX100 / 100 : null,
    count: shop.ratingCount,
    reviews: await listShopReviews(id, 20),
  });
});
