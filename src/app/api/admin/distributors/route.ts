/** GET → distributors with their codes, shops and commission · POST → add a distributor (Module 3). */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { distributorSchema, listDistributors, saveDistributor } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  return ok({ distributors: await listDistributors() });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.REFERRAL_MANAGE);
  return ok({ distributor: await saveDistributor(null, await parseBody(request, distributorSchema), user) }, 201);
});
