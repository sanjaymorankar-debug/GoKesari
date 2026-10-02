/**
 * One user account, edited by an admin (`/admin/users/[id]`).
 *
 * `PATCH` carries the whole profile draft from one Save press. Admin only:
 * USER_EDIT_PROFILE is absent from OPERATOR_PERMISSIONS, so an operator may
 * still list accounts but not change them.
 *
 * `email`, `phoneE164` and `phoneVerifiedAt` are deliberately not accepted —
 * see the note on updateUserProfileByAdmin().
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { updateUserProfileByAdmin } from "@/server/services/users";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().max(120).nullish(),
  phone: z.string().max(20).nullish(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  statusReason: z.string().max(500).optional(),
});

export const PATCH = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requirePermission(PERMISSIONS.USER_EDIT_PROFILE);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  return ok(await updateUserProfileByAdmin(id, body, actor));
});
