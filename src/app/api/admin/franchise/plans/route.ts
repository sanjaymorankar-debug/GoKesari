/**
 * Admin → Franchise → Plans (docs/onboarding-v2-2026-11 §Defaults #4): subscription plans for a paid franchise zone.
 * GET → every plan (operators may read); POST → add one (admin only, audited).
 */
import { type NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireFranchiseAdmin, requireFranchiseReader } from "@/server/franchise/http";
import { createPlan, listPlans } from "@/server/onboarding-v2/franchise";
import { planInputSchema } from "./schema";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireFranchiseReader();
  return ok({ plans: await listPlans() });
});

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  return ok({ plan: await createPlan(await parseBody(request, planInputSchema), actor) }, 201);
});
