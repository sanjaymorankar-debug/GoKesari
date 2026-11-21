/**
 * POST { zoneIds, couponCode?, test? } — reserve one slot in each zone for 15 minutes (all-or-nothing; §5.5). The
 * amounts are computed on the server from the zones' published fees and the coupon; the client sends only ids.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { reserveZones } from "@/server/franchise/booking";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`franchise-reserve:${user.id}`, RATE_LIMITS.CHECKOUT);
  const body = await parseBody(request, z.object({ zoneIds: z.array(z.string().trim().min(1).max(16)).min(1).max(50), couponCode: z.string().trim().max(30).nullish(), test: z.boolean().optional() }));
  const r = await reserveZones(user, body);
  return ok({ booking: r.booking, allocations: r.allocations.map((a) => ({ id: a.id, zoneId: a.zoneId, slotNo: a.slotNo, status: a.status, tier: a.tier, feePaise: a.feePaise, discountPaise: a.discountPaise, holdExpiresAt: a.holdExpiresAt })) }, 201);
});
