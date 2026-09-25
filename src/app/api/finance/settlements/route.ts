/**
 * Weekly shop settlements (GS-062). GET lists — FINANCE_VIEW. POST prepares
 * DRAFT settlements for a week (default: last week) — FINANCE_PREPARE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listShopSettlements, prepareShopSettlements, previousWeekStart } from "@/server/services/finance";

const schema = z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await listShopSettlements());
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_PREPARE);
  const body = await parseBody(request, schema);
  return ok(await prepareShopSettlements(body.weekStart ?? previousWeekStart(), user), 201);
});
