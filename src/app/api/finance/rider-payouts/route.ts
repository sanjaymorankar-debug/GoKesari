/**
 * Weekly rider payouts (GS-064). GET lists — FINANCE_VIEW. POST prepares
 * DRAFT payouts for a week (default: last week) — FINANCE_PREPARE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listRiderPayouts, prepareRiderPayouts, previousWeekStart } from "@/server/services/finance";

const schema = z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await listRiderPayouts());
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_PREPARE);
  const body = await parseBody(request, schema);
  return ok(await prepareRiderPayouts(body.weekStart ?? previousWeekStart(), user), 201);
});
