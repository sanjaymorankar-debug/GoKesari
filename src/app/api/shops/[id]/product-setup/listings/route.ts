/** Step 3 and My products: save prices and quantities, a batch at a time. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { saveListingEdits, setListingPaused } from "@/server/services/shop-product-setup";

export const dynamic = "force-dynamic";

const pause = z.object({ shopProductId: z.string().uuid(), paused: z.boolean() });

/** The owner pauses or restarts one listing. */
export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  const { shopProductId, paused } = await parseBody(request, pause);
  await setListingPaused(id, shopProductId, paused, user);
  return ok({ paused });
});

const body = z.object({
  action: z.enum(["live", "skip"]),
  rows: z
    .array(
      z.object({
        shopProductId: z.string().uuid(),
        pricePaise: z.number().nullable().optional(),
        stock: z.number().nullable().optional(),
        shopMrpPaise: z.number().nullable().optional(),
        expectedOnlineStock: z.number().optional(),
      }),
    )
    .max(200),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  const { action, rows } = await parseBody(request, body);
  return ok(await saveListingEdits(id, rows, action, user));
});
