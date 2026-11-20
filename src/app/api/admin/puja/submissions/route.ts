/**
 * Review queue (brief §5h, §6): GET → owner-created product types and products waiting;
 * POST { kind: TYPE|PRODUCT, id, decision: APPROVE|REJECT|MERGE, reason?, mergeIntoId? }.
 * Reject and merge need a reason; the owner is told at once (in-app + push).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { decideSubmission, listSubmissions } from "@/server/puja/admin";
import { requirePujaStaff } from "@/server/puja/route-helpers";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requirePujaStaff();
  return ok({ submissions: await listSubmissions() });
});

const schema = z.object({
  kind: z.enum(["TYPE", "PRODUCT"]),
  id: z.string().uuid(),
  decision: z.enum(["APPROVE", "REJECT", "MERGE"]),
  reason: z.string().trim().max(500).nullish(),
  mergeIntoId: z.string().uuid().nullish(),
});

export const POST = route(async (request: NextRequest) => {
  const user = await requirePujaStaff();
  return ok(await decideSubmission(await parseBody(request, schema), user));
});
