/** Admin: POST { decision: RELEASE | REVERSE, reason } — decide a held / disputed franchise attribution (brief §7). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { decideAttribution } from "@/server/franchise/commission";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ shopId: string }>) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, z.object({ decision: z.enum(["RELEASE", "REVERSE"]), reason: z.string().min(5).max(300) }));
  await decideAttribution((await params).shopId, b.decision, b.reason, actor);
  return ok({ shopId: (await params).shopId, decision: b.decision });
});
