/**
 * "Check" a purchase list: the quantities set for this time, priced now —
 * prices, offers, stock and delivery fees, exactly as the cart prices them —
 * for the customer to confirm before it goes to the cart. Writes nothing.
 */
import type { NextRequest } from "next/server";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { checkPurchaseList } from "@/server/services/purchase-lists";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  return ok(await checkPurchaseList(user.id, id));
});
