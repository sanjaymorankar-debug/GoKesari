/** Admin: POST { month: "YYYY-MM", force? } — run (or re-run, adding only what is missing) a month's ratings and recurring commission. */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { runFranchiseMonth } from "@/server/franchise/commission";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), force: z.boolean().optional() }));
  return ok(await runFranchiseMonth(b.month, actor, { force: b.force }));
});
