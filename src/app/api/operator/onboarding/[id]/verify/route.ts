/** POST { code } — the code the owner read out; only then can the shop be registered for them (F8.4.2). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { clientKey, enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { verifyOwnerConsent } from "@/server/services/operator-limited";

export const dynamic = "force-dynamic";

const schema = z.object({ code: z.string().trim().min(4).max(12) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.OPERATOR_LIMITED_ONBOARD);
  enforceRateLimit(clientKey(request, `opltd-verify:${user.id}`), RATE_LIMITS.SHOP_IDENTITY_CHECK);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  return ok(await verifyOwnerConsent(z.string().uuid().parse(id), body, user, ip));
});
