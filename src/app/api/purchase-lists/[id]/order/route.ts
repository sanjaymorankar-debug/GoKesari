/**
 * The customer confirmed a checked list: its lines go to the cart (added to
 * it, or replacing it) and checkout takes the address and payment as usual.
 * Prices are never taken from the request; the cart and checkout price live.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { sendPurchaseListToCart } from "@/server/services/purchase-lists";

export const dynamic = "force-dynamic";

const schema = z.object({ mode: z.enum(["ADD", "REPLACE"]).default("ADD") });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const { mode } = await parseBody(request, schema);
  return ok(await sendPurchaseListToCart(user.id, id, mode));
});
