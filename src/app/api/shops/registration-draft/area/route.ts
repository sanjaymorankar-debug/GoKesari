/** Onboarding wizard: POST { areaId } — the shop's area, confirmed by the owner (franchise brief 21-Nov-2026 §5.1). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { saveDraftArea } from "@/server/services/shop-registration-wizard";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  enforceRateLimit(`registration-draft:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await parseBody(request, z.object({ areaId: z.string().uuid() }));
  return ok(await saveDraftArea({ actor: user, areaId: body.areaId }));
});
