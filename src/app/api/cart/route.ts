/** Cart contents, grouped by shop with live prices (requirement §17). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { addToCart, clearCart, getCart } from "@/server/services/cart";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok(await getCart(user.id));
});

const addSchema = z.object({
  shopProductId: z.string().uuid(),
  // Whole for packaged goods, parts of a unit for loose ones — checked against the product (D-95).
  quantity: z.number().positive().max(99).default(1),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const { shopProductId, quantity } = await parseBody(request, addSchema);
  // Purchasability (§14) is enforced inside the service, not here.
  return ok(await addToCart(user.id, shopProductId, quantity));
});

export const DELETE = route(async () => {
  const user = await requireUser();
  await clearCart(user.id);
  return ok(await getCart(user.id));
});
