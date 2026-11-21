/** Admin: PATCH { status: SUSPENDED | ACTIVE | TERMINATED | CANCELLED, reason } — suspend, resume, terminate, or void a test allocation. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { setAllocationStatus } from "@/server/franchise/booking";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const PATCH = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, z.object({ status: z.enum(["SUSPENDED", "ACTIVE", "TERMINATED", "CANCELLED"]), reason: z.string().min(5).max(300) }));
  const a = await setAllocationStatus((await params).id, b.status, b.reason, actor);
  return ok({ id: a.id, status: a.status });
});
