/**
 * Act on a membership: approve / decline (society ADMIN/OPERATOR), set role
 * (society ADMIN), remove (staff) or leave (the member). Checked in the service.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { decideMembership, removeMember, setMemberRole } from "@/server/services/societies";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("decline") }),
  z.object({ action: z.literal("role"), role: z.enum(["ADMIN", "OPERATOR", "RESIDENT"]) }),
  z.object({ action: z.literal("remove") }),
]);

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ memberId: string }>) => {
  const user = await requireUser();
  const { memberId } = await context.params;
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "approve":
      return ok(await decideMembership(memberId, true, user));
    case "decline":
      return ok(await decideMembership(memberId, false, user));
    case "role":
      return ok(await setMemberRole(memberId, body.role, user));
    case "remove":
      return ok(await removeMember(memberId, user));
  }
});
