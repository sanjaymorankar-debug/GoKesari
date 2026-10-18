/** POST { email, role? } — link a user to a manufacturer account (batch-2026-10 WS-D, F9.1.2). PMD_MANUFACTURER_MANAGE. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { addManufacturerMember } from "@/server/pmd/manufacturers";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().email(), role: z.enum(["OWNER", "UPLOADER"]).optional() });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requirePermission(PERMISSIONS.PMD_MANUFACTURER_MANAGE);
  const id = z.string().uuid().parse((await context.params).id);
  const body = await parseBody(request, schema);
  return ok(await addManufacturerMember(id, body, user), 201);
});
