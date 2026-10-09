/** GET ?code=&distributorId=&from=&to=&profile=complete|incomplete&q= → self-registered shops (Module 3). Suspend through POST /api/shops/{id}/suspend. */
import type { NextRequest } from "next/server";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { autoApprovedQuerySchema, listAutoApprovedShops } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  return ok({ shops: await listAutoApprovedShops(parseQuery(request, autoApprovedQuerySchema)) });
});
