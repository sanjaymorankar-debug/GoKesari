/**
 * Admin: POST { month: "YYYY-MM", action: "calculate" | "lock" } — recalculate a month's dealer-code snapshots
 * (allowed until it is locked) or lock it for payout (writes the recurring / bonus / adjustment lines; brief 21-Nov §5).
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { calculateFranchiseMonth, lockFranchiseMonth } from "@/server/franchise/commission";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), action: z.enum(["calculate", "lock"]).default("calculate") }));
  return ok(b.action === "lock" ? await lockFranchiseMonth(b.month, actor) : await calculateFranchiseMonth(b.month, actor));
});
