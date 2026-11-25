/** Module 10: what one staff member did in this shop (audit entries), for the owner. GET ?limit= */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { listStaffActivity } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), staffId: z.string().uuid() });

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string; staffId: string }>) => {
  const { id, staffId } = ids.parse(await context.params);
  const user = await requireUser();
  const limit = z.coerce.number().int().min(1).max(500).catch(200).parse(request.nextUrl.searchParams.get("limit") ?? 200);
  return ok({ activity: await listStaffActivity(id, staffId, user, limit) });
});
