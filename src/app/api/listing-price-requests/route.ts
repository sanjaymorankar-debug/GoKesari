/**
 * A customer's "price on confirmation" requests (brief §7). POST { shopProductId, quantity?, note? }
 * asks the shop for the price of a loose / perishable item without one (the shop is told at
 * once); GET → the customer's own requests and answers.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { clientKey, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { listMyPriceRequests, requestListingPrice } from "@/server/puja/storefront";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ requests: await listMyPriceRequests(user.id) });
});

const schema = z.object({
  shopProductId: z.string().uuid(),
  quantity: z.number().positive().max(10_000).nullish(),
  note: z.string().trim().max(300).nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(clientKey(request, `price-request:${user.id}`), { limit: 20, windowMs: 60 * 60_000 });
  const body = await parseBody(request, schema);
  return ok(await requestListingPrice(user.id, body.shopProductId, body), 201);
});
