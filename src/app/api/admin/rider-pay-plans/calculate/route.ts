/** What a rider would see for these numbers: the plan that applies, surges, the full quote and wait pay. Nothing is saved. */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { calculate } from "@/server/services/rider-pay-plans";

import { calculateSchema } from "../schemas";

export const POST = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const body = await parseBody(request, calculateSchema);
  return ok(await calculate({ ...body, at: body.at ? new Date(body.at) : null }));
});
