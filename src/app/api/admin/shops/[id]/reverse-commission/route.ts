/**
 * Admin: POST { reason } — reverse every dealer / franchise commission on a shop (fraud, duplicate, verification
 * revoked; franchise brief §2.5). Unpaid entries become REVERSED; paid ones get a negative entry. Audited.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { reverseShopCommission } from "@/server/dealers/commission";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const admin = await requireRole("ADMIN");
  const body = await parseBody(request, z.object({ reason: z.string().min(5).max(500) }));
  return ok({ reversed: await reverseShopCommission((await params).id, body.reason, admin) });
});
