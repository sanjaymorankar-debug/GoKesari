/** Billing v2: record that a return was filed on the portal, with its ARN / acknowledgement. STATUTORY_MANAGE. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { isUuid } from "@/server/payouts/http";
import { markFiled } from "@/server/tax/compliance";

const body = z.object({ acknowledgement: z.string().trim().min(5).max(80) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.STATUTORY_MANAGE);
  const { id } = await context.params;
  if (!isUuid(id)) throw notFound("Filing");
  const { acknowledgement } = await parseBody(request, body);
  return ok(await markFiled(id, acknowledgement, user));
});
