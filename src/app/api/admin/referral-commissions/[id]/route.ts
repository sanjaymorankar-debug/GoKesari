/** PATCH { status: APPROVED|PAID|REVERSED, note? } → track a commission (admin). ACCRUED → APPROVED → PAID; REVERSED before payment. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { setCommissionStatus } from "@/server/registration/admin";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.REGISTRATION_FEE_MANAGE);
  const id = z.string().uuid().parse((await context.params).id);
  const { status, note } = await parseBody(request, z.object({ status: z.enum(["APPROVED", "PAID", "REVERSED"]), note: z.string().trim().max(300).nullish() }));
  return ok({ commission: await setCommissionStatus(id, status, note ?? null, user) });
});
