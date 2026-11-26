/** One pay-plan version: read it, or edit it while it is a draft (published versions are read-only). */
import type { NextRequest } from "next/server";

import { toPlanRow } from "@/components/admin/rider-pay-plans/serialize";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { getPlan, updateDraft } from "@/server/services/rider-pay-plans";

import { planSchema } from "../schemas";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { id } = await context.params;
  return ok({ plan: toPlanRow(await getPlan(id)) });
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const { id } = await context.params;
  const saved = await updateDraft(id, await parseBody(request, planSchema), user);
  return ok({ plan: toPlanRow(saved) });
});
