/** Marks every item of a wishlist "to buy" again (re-order the same list). */
import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { getWishlist, resetWishlistStatus } from "@/server/services/smart-list/wishlist";

export const dynamic = "force-dynamic";

export const POST = route(async (_r: Request, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  await resetWishlistStatus(user.id, id);
  return ok(await getWishlist(user.id, id));
});
