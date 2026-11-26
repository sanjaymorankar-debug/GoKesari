/** Flow 2 operator queue: approve a registration licence waiting for the team, or reject it with a reason. Audited. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { reviewRegistrationLicence } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";

const schema = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().max(500).nullish() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await reviewRegistrationLicence(z.string().uuid().parse(id), { approve: body.decision === "approve", reason: body.reason ?? null }, user));
});
