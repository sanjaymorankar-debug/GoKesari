/** Admin: POST { ownerDealerId, level, note, allocationId? } — warning → recorded → suspension / termination (brief §3.3). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { recordViolation } from "@/server/franchise/dashboard";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(request, z.object({ ownerDealerId: z.string().uuid(), level: z.enum(["WARNING", "RECORDED", "SUSPENSION", "TERMINATION"]), note: z.string().min(5).max(1000), allocationId: z.string().uuid().nullish() }));
  await recordViolation(b, actor);
  return ok({ recorded: true }, 201);
});
