/** Audience size for a broadcast being composed (F3.3.2): POST { audience } → { count }. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { estimateAudience } from "@/server/services/broadcasts";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.BROADCAST_MANAGE);
  const { audience } = await parseBody(request, z.object({ audience: z.unknown() }));
  return ok({ count: await estimateAudience(user, audience) });
});
