/** Update or remove a single cart line. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { CART_LINE_MAX_QUANTITY, removeCartItem, setCartItemQuantity } from "@/server/services/cart";

const patchSchema = z.object({
  quantity: z.number().int().min(0).max(CART_LINE_MAX_QUANTITY),
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
