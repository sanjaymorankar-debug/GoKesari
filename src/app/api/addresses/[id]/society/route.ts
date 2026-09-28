/**
 * Mark one of your own addresses as inside a society you are an active member
 * of — or clear it (`societyId: null`). Society delivery rules then apply.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { linkAddressToSociety } from "@/server/services/societies";

const schema = z.object({ societyId: z.string().uuid().nullable() });

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  await linkAddressToSociety(user.id, id, body.societyId);
  return ok({ ok: true });
});
