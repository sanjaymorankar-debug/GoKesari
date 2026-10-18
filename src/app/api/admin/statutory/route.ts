/**
 * Dated statutory settings (STATUTORY_MANAGE): list, and add a row from a
 * date (the row in force before it is closed the day before).
 */
import type { NextRequest } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { addStatutoryRate, listStatutoryRates, statutoryRateInput } from "@/server/statutory/rates";

export const GET = route(async () => {
  await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  return ok(await listStatutoryRates());
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  const body = await parseBody(request, statutoryRateInput);
  return ok(await addStatutoryRate(body, user), 201);
});
