/** Verify / reject / suspend / reinstate a society. SOCIETY_MANAGE_ANY (operator/admin). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { decideSociety } from "@/server/services/societies";

const schema = z.object({
  decision: z.enum(["verify", "reject", "suspend", "reinstate"]),
  reason: z.string().max(300).optional(),
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.SOCIETY_MANAGE_ANY);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await decideSociety(id, body.decision, user, body.reason));
});
