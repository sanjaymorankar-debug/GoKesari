/**
 * Admin → Rider insurance, one policy.
 *   PUT   {…same body as POST /api/admin/rider-insurance} → {policy}
 *   PATCH {isActive} → {policy} (activate / deactivate without editing)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { savePolicy, setPolicyActive } from "@/server/services/rider-insurance";
import { policySchema, toPolicyInput } from "../policy-schema";

export const dynamic = "force-dynamic";

async function guard(context: RouteContext<{ id: string }>) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Policy");
  const user = await requirePermission(PERMISSIONS.DELIVERY_PARTNER_MANAGE);
  enforceRateLimit(`admin-rider-insurance:${user.id}`, RATE_LIMITS.MUTATION);
  return { id, user };
}

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id, user } = await guard(context);
  const body = await parseBody(request, policySchema);
  return ok({ policy: await savePolicy(toPolicyInput(body), user, id) });
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id, user } = await guard(context);
  const body = await parseBody(request, z.object({ isActive: z.boolean() }));
  return ok({ policy: await setPolicyActive(id, body.isActive, user) });
});
