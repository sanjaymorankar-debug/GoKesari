/** The customer's saved wishlists (from photo lists): list and save. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { itemInputSchema, listWishlists, saveWishlist } from "@/server/services/smart-list/wishlist";

export const dynamic = "force-dynamic";

const saveSchema = z.object({
  name: z.string().max(80).optional(),
  scanId: z.string().uuid().nullable().optional(),
  items: z.array(itemInputSchema).min(1).max(100),
});

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ wishlists: await listWishlists(user.id) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  return ok(await saveWishlist(user.id, await parseBody(request, saveSchema)), 201);
});
