/** RBAC v2 Phase 3: rate proposals. GET (Accountant, CA, Admin); POST (Accountant) proposes. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { SHOP_TYPE_KEY_PATTERN } from "@/lib/shop-types";
import { ok, parseBody, route } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { RATE_KINDS } from "@/server/db/schema";
import { listRateProposals, proposeRateChange } from "@/server/rbac-accounting/rates";
import { requireFeatureForRole } from "@/server/services/feature-flags";

export const dynamic = "force-dynamic";

const schema = z.object({
  rateKind: z.enum(RATE_KINDS),
  scope: z.enum(["DEFAULT", "SHOP_TYPE", "SHOP"]).optional(),
  shopType: z.string().regex(SHOP_TYPE_KEY_PATTERN).nullish(),
  shopId: z.string().uuid().nullish(),
  rateBp: z.number().int().min(0).max(5000).optional(),
  amountPaise: z.number().int().min(0).optional(),
  effectiveAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(5).max(500),
});

export const GET = route(async () => {
  const actor = await requireAnyPermission([PERMISSIONS.RATE_PROPOSE, PERMISSIONS.RATE_APPROVE, PERMISSIONS.RATE_ACTIVATE]);
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  return ok(await listRateProposals());
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireAnyPermission([PERMISSIONS.RATE_PROPOSE]);
  const body = await parseBody(request, schema);
  return ok(await proposeRateChange({ ...body, effectiveAt: new Date(body.effectiveAt) }, actor), 201);
});
