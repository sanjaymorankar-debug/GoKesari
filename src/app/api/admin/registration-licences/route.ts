/**
 * docs/onboarding-v2-2026-11 (Flow 2): Admin → Shop documents → Registration licences. Licences answered at shop
 * registration (enter / upload / scan / upload later), per shop, with their status and promise deadline.
 *   GET ?status=PENDING_OPERATOR|PROMISED|VERIFIED|REJECTED|ALL&shopId=   SHOP_REGISTRATION_MANAGE (admin, operators)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { LICENCE_ENTRY_STATUSES } from "@/server/db/schema";
import { listRegistrationLicences } from "@/server/onboarding-v2/shop-flow";

export const dynamic = "force-dynamic";

const schema = z.object({
  status: z.enum([...LICENCE_ENTRY_STATUSES, "ALL"]).default("PENDING_OPERATOR"),
  shopId: z.string().uuid().optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  const query = parseQuery(request, schema);
  return ok({ entries: await listRegistrationLicences({ status: query.status, shopId: query.shopId ?? null }) });
});
