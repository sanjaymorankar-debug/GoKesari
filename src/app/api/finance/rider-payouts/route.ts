/**
 * Weekly rider payouts (GS-064). GET lists — FINANCE_VIEW. POST prepares
 * DRAFT payouts for a week (default: last week) — FINANCE_PREPARE.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isoDateSchema } from "@/server/api/date-schema";
import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { listRiderPayouts, prepareRiderPayouts, previousWeekStart } from "@/server/services/finance";

// TC-FLD-118: a real date (the service also checks it is a Monday of a finished / started week).
const schema = z.object({ weekStart: isoDateSchema.optional() });

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.FINANCE_VIEW);
  return ok(await listRiderPayouts());
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_PREPARE);
  const body = await parseBody(request, schema);
  return ok(await prepareRiderPayouts(body.weekStart ?? previousWeekStart(), user), 201);
});
