/** Rider payout lifecycle (Part F) — same actions as settlements. FINANCE_MANAGE (admin). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideRiderPayout } from "@/server/services/finance";

const schema = z.object({
  action: z.enum(["approve", "process", "pay", "fail", "reverse", "cancel"]),
  /** Bank/UTR reference for "pay"; the bank's reason for "fail" / "reverse". */
  note: z.string().max(200).optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.FINANCE_MANAGE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await decideRiderPayout(id, body.action, user, body.note));
});
