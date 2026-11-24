/** One plan a customer can take now (docs/subscription-plans-2026-11); 404 when switched off or gone. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { getPublicPlan } from "@/server/services/subscription-plans";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ planId: string }>) => {
  const { planId } = await context.params;
  z.string().uuid().parse(planId);
  const plan = await getPublicPlan(planId);
  if (!plan) throw notFound("Subscription plan");
  return ok(plan);
});
