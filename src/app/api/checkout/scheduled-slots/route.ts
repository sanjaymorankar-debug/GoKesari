/**
 * GS-027: the delivery times a customer can choose for a scheduled delivery
 * from one shop — future slots, inside the shop's hours, after the cut-off,
 * with places left. A checkout-time read; the place is re-checked when the
 * order is placed.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { listScheduledSlots } from "@/server/services/scheduled-slots";

const schema = z.object({ shopId: z.string().uuid() });

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const { shopId } = parseQuery(request, schema);
  return ok(await listScheduledSlots(shopId));
});
