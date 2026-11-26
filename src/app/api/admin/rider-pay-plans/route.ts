/**
 * Rider pay plans (docs/rider-app-v2-2026-11): every version of every plan, and creating a new
 * plan (its version 1 draft). Amounts in paise, distances in metres. Audited by the service.
 */
import type { NextRequest } from "next/server";

import { toPlanRow } from "@/components/admin/rider-pay-plans/serialize";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { createPlan, listPlans } from "@/server/services/rider-pay-plans";

import { planSchema } from "./schemas";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const plans = await listPlans();
  return ok({ plans: plans.map((p) => toPlanRow(p, { inForce: p.inForce, words: p.words, label: p.label })) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
  const saved = await createPlan(await parseBody(request, planSchema), user);
  return ok({ plan: toPlanRow(saved) }, 201);
});
