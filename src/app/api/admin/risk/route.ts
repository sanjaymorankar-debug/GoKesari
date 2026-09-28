/**
 * Fraud / risk review queue (GS-068). GET lists flags (default OPEN);
 * POST runs the rules now. RISK_REVIEW (operator, admin).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseQuery, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { riskFlagStatusEnum } from "@/server/db/schema";
import { listRiskFlags, runRiskRules } from "@/server/services/risk";

export const dynamic = "force-dynamic";

const schema = z.object({ status: z.enum(riskFlagStatusEnum.enumValues).optional() });

export const GET = route(async (request: NextRequest) => {
  await requirePermission(PERMISSIONS.RISK_REVIEW);
  const { status } = parseQuery(request, schema);
  return ok(await listRiskFlags({ status }));
});

export const POST = route(async () => {
  const actor = await requirePermission(PERMISSIONS.RISK_REVIEW);
  return ok(await runRiskRules(actor));
});
