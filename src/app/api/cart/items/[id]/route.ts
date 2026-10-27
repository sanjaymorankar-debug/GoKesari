/** Update or remove a single cart line. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { removeCartItem, setCartItemQuantity } from "@/server/services/cart";

const patchSchema = z.object({
  // Whole for packaged goods, parts of a unit for loose ones — checked against the product (D-95).
  quantity: z.number().min(0).max(99),
});

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requireUser();
    const { id } = await context.params;
    const { quantity } = await parseBody(request, patchSchema);
    return ok(await setCartItemQuantity(user.id, id, quantity));
  },
);

export const DELETE = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requireUser();
    const { id } = await context.params;
    return ok(await removeCartItem(user.id, id));
  },
);
