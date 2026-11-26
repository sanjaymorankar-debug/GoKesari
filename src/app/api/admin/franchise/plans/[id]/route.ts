/**
 * Admin, one franchise plan (docs/onboarding-v2-2026-11):
 *   PUT    full plan (as POST)                 edit
 *   PATCH  { active: boolean }                 deactivate / reactivate
 * Admin only; every change audited.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireFranchiseAdmin } from "@/server/franchise/http";
import { setPlanActive, updatePlan } from "@/server/onboarding-v2/franchise";
import { planInputSchema } from "../schema";

export const dynamic = "force-dynamic";

export const PUT = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const actor = await requireFranchiseAdmin();
  const id = z.string().uuid().parse((await params).id);
  return ok({ plan: await updatePlan(id, await parseBody(request, planInputSchema), actor) });
});

export const PATCH = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const actor = await requireFranchiseAdmin();
  const id = z.string().uuid().parse((await params).id);
  const b = await parseBody(request, z.object({ active: z.boolean() }));
  return ok({ plan: await setPlanActive(id, b.active, actor) });
});
