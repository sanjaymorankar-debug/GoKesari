/**
 * Billing v2 (docs/billing §5.7): GoKesari's compliance calendar (GET) and
 * generating one of its returns for a period (POST) — GSTR-8, GSTR-1,
 * GSTR-3B, the quarterly TDS statement. STATUTORY_MANAGE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { STATUTORY_RETURN_TYPES } from "@/server/db/schema";
import { requireFeature } from "@/server/services/feature-flags";
import { istDay } from "@/server/statutory/rates";
import { complianceCalendar, generateFiling } from "@/server/tax/compliance";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  await requireFeature("billing_v2");
  return ok(await complianceCalendar(istDay(new Date())));
});

const body = z.object({
  returnType: z.enum(STATUTORY_RETURN_TYPES),
  period: z.string().regex(/^\d{4}-(\d{2}|\d{2}-Q[1-4])$/),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  await requireFeature("billing_v2");
  const input = await parseBody(request, body);
  if (input.returnType === "GSTR8") await requireFeature("tcs_engine");
  if (input.returnType === "TDS_STATEMENT") await requireFeature("tds_engine");
  return ok(await generateFiling(input.returnType, input.period, user), 201);
});
