/** Admin / operator: POST { areaId, reason } — correct a shop's area (§5.1; audited; affects only commission earned after the change). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireFranchiseReader } from "@/server/franchise/http";
import { correctShopArea, shopAreaAt } from "@/server/franchise/zones";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, { params }: RouteContext<{ shopId: string }>) => {
  await requireFranchiseReader();
  return ok({ area: await shopAreaAt((await params).shopId) });
});

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ shopId: string }>) => {
  const user = await requireFranchiseReader();
  const b = await parseBody(request, z.object({ areaId: z.string().uuid(), reason: z.string().trim().min(5).max(500) }));
  const zoneId = await correctShopArea((await params).shopId, b.areaId, b.reason, { id: user.id, role: user.role });
  return ok({ zoneId });
});
