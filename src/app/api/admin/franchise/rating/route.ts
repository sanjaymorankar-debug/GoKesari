/** Admin: POST { formula: { metrics, tiers }, publish, reason } — the performance-bonus formula (brief §8.3, D2). */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { RATING_METRICS, saveRatingFormula } from "@/server/franchise/commission";
import { requireFranchiseAdmin } from "@/server/franchise/http";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest) => {
  const actor = await requireFranchiseAdmin();
  const b = await parseBody(
    request,
    z.object({
      formula: z.object({
        metrics: z.array(z.object({ key: z.enum(RATING_METRICS), weight: z.number().min(0).max(100), target: z.number().positive() })).min(1).max(10),
        tiers: z.array(z.object({ minScore: z.number().min(0).max(100), bonusBp: z.number().int().min(0).max(10_000) })).min(1).max(20),
      }),
      publish: z.boolean(),
      reason: z.string().min(5).max(500),
    }),
  );
  return ok({ version: await saveRatingFormula(b.formula, b.publish, b.reason, actor) }, 201);
});
