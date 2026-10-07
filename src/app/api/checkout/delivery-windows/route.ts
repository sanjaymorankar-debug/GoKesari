/**
 * Delivery-window feasibility preview (delivery-system Part 58, Slice C).
 * Public — a checkout-time read, never promising a window the system can't
 * actually back (see delivery-feasibility.ts).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { getFeasibleDeliveryWindows } from "@/server/services/delivery-feasibility";

const schema = z.object({ shopId: z.string().uuid() });

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  const { shopId } = parseQuery(request, schema);
  // Only the windows. The distance to the nearest online rider, and the
  // estimate built from it, would let anyone who asks about a few shops
  // place that rider; checkout reads neither.
  const { EXPRESS_30, STANDARD_60, SCHEDULED, full } = await getFeasibleDeliveryWindows(shopId);
  return ok({ EXPRESS_30, STANDARD_60, SCHEDULED, ...(full ? { full } : {}) });
});
